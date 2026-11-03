"""Persistence and workflow-contract tests for the infinite-canvas plugin."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

from jsonschema import Draft202012Validator

from backend.modules.projects.service import ProjectService
from backend.modules.shared.plugin_runtime import PluginError, PluginRuntime
from backend.persistence.database import Database


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("infinite_canvas_test_plugin", ROOT / "actions.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def workflow(workflow_id="workflow-test01"):
    return {
        "schema_version": 1,
        "kind": "videofree.infinite-canvas",
        "id": workflow_id,
        "name": "Test workflow",
        "nodes": [
            {"id": "node-source", "type": "test.source", "position": {"x": 0, "y": 0}, "config": {}, "values": {}},
            {"id": "node-target", "type": "test.target", "position": {"x": 300, "y": 0}, "config": {}, "values": {}},
        ],
        "edges": [{"id": "edge-first", "from": {"node": "node-source", "port": "out"}, "to": {"node": "node-target", "port": "in"}}],
        "viewport": {"x": 10, "y": 20, "zoom": 1},
    }


class InfiniteCanvasTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        database = Database(root / "canvas.sqlite")
        database.initialize({})
        self.context = SimpleNamespace(
            db=database, application_semaphores={}, jobs={}, executing_jobs=set(),
            paths=SimpleNamespace(projects=root / "projects", uploads=root / "uploads"),
        )
        self.service = ProjectService(self.context)
        self.project = self.service.create("Canvas")['id']

    async def call(self, name, inputs=None, project=None):
        runtime = PluginRuntime("infinite-canvas", {}, self.context, project or self.project, None)
        return await module.execute({"action": {"id": f"infinite-canvas.{name}"}, "inputs": inputs or {}}, runtime)

    async def test_create_list_get_update_and_delete(self):
        created = await self.call("save", {"workflow": workflow(), "expected_revision": 0})
        self.assertEqual(created["revision"], 1)
        self.assertEqual((await self.call("list"))["items"][0]["node_count"], 2)
        loaded = await self.call("get", {"workflow_id": "workflow-test01"})
        self.assertEqual(loaded["workflow"]["edges"][0]["to"]["port"], "in")
        loaded["workflow"]["name"] = "Updated"
        updated = await self.call("save", {"workflow": loaded["workflow"], "expected_revision": 1})
        self.assertEqual(updated["revision"], 2)
        with self.assertRaises(PluginError) as conflict:
            await self.call("save", {"workflow": loaded["workflow"], "expected_revision": 1})
        self.assertEqual(conflict.exception.status_code, 409)
        with self.assertRaises(PluginError):
            await self.call("delete", {"workflow_id": "workflow-test01", "expected_revision": 1})
        self.assertTrue((await self.call("delete", {"workflow_id": "workflow-test01", "expected_revision": 2}))["deleted"])
        self.assertEqual((await self.call("list"))["items"], [])

    async def test_rejects_cycles_unknown_fields_and_invalid_references(self):
        cyclic = workflow()
        cyclic["edges"].append({"id": "edge-back", "from": {"node": "node-target", "port": "out"}, "to": {"node": "node-source", "port": "in"}})
        control_cycle = workflow("workflow-control-cycle")
        control_cycle["edges"].append({"id": "edge-control-back", "kind": "control", "from": {"node": "node-target", "port": "done"}, "to": {"node": "node-source", "port": "flow_control"}})
        for invalid in (
            cyclic,
            control_cycle,
            {**workflow(), "absolute_path": "C:/private/file"},
            {**workflow(), "edges": [{"id": "edge-bad", "from": {"node": "node-missing", "port": "out"}, "to": {"node": "node-target", "port": "in"}}]},
        ):
            with self.assertRaises(PluginError) as caught:
                await self.call("save", {"workflow": invalid, "expected_revision": 0})
            self.assertEqual(caught.exception.status_code, 422)

    async def test_loop_edges_are_persisted_outside_the_forward_dag(self):
        value = workflow()
        value["nodes"].insert(1, {"id": "node-condition", "type": "test.condition", "position": {"x": 150, "y": 180}, "config": {}, "values": {}})
        value["edges"].append({
            "id": "edge-loop",
            "kind": "loop",
            "from": {"node": "node-condition", "port": "failure"},
            "to": {"node": "node-source", "port": "flow_control"},
        })
        saved = await self.call("save", {"workflow": value, "expected_revision": 0})
        self.assertEqual(saved["workflow"]["edges"][0]["kind"], "data")
        self.assertEqual(saved["workflow"]["edges"][1]["kind"], "loop")

    async def test_agent_skills_are_plugin_owned_and_discoverable(self):
        result = await self.call("agent-skills")
        self.assertEqual([item["id"] for item in result["items"]], ["general", "visual-review"])
        self.assertTrue(all("instructions" not in item for item in result["items"]))

    async def test_system_agent_returns_the_stable_decision_envelope(self):
        runtime = PluginRuntime(
            "infinite-canvas", {}, self.context, self.project, None,
            _call_model=lambda messages, max_tokens: json.dumps({
                "decision": "retry", "text": "reviewed", "result": {"ok": False},
                "score": 42, "reason": "blurred", "retry_prompt": "increase sharpness",
            }),
        )
        result = await module.execute({"action": {"id": "infinite-canvas.agent-run"}, "inputs": {
            "skill_id": "visual-review", "task_prompt": "Act as a reviewer and check it",
            "llm_source": "system",
        }}, runtime)
        self.assertEqual(result["decision"], "retry")
        self.assertEqual(result["retry_prompt"], "increase sharpness")
        self.assertEqual(result["score"], 42)

    async def test_agent_rejects_unreadable_and_unsupported_media(self):
        def resolve_media(project_id, path):
            if path == "missing.png":
                raise FileNotFoundError(path)
            return Path(path)

        runtime = SimpleNamespace(
            project_id=self.project,
            application=SimpleNamespace(resolve_library_path=resolve_media),
            call_model=lambda messages, max_tokens: '{"decision":"pass"}',
        )
        with self.assertRaises(PluginError) as missing:
            await module._run_agent({"task_prompt": "Review", "media": [{"path": "missing.png"}]}, runtime)
        self.assertEqual(missing.exception.status_code, 422)

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(PluginError) as not_file:
                await module._run_agent({"task_prompt": "Review", "media": [{"path": directory}]}, runtime)
            self.assertEqual(not_file.exception.status_code, 422)

            unsupported = Path(directory) / "notes.txt"
            unsupported.write_text("not media", encoding="utf-8")
            with self.assertRaises(PluginError) as wrong_type:
                await module._run_agent({"task_prompt": "Review", "media": [{"path": str(unsupported)}]}, runtime)
            self.assertEqual(wrong_type.exception.status_code, 422)

        with self.assertRaises(PluginError) as too_many:
            await module._run_agent({"task_prompt": "Review", "media": [{"path": "image.png"}] * 9}, runtime)
        self.assertEqual(too_many.exception.status_code, 422)

        for invalid_path in (12, {"path": "nested"}, ["path"]):
            with self.assertRaises(PluginError) as invalid:
                await module._run_agent({"task_prompt": "Review", "media": [{"path": invalid_path}]}, runtime)
            self.assertEqual(invalid.exception.status_code, 422)

    async def test_agent_reads_media_once_and_rejects_actual_size_over_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "sample.png"
            image.write_bytes(b"x" * (12 * 1024 * 1024))
            captured = {}
            runtime = SimpleNamespace(
                project_id=self.project,
                application=SimpleNamespace(resolve_library_path=lambda project_id, path: image),
                call_model=lambda messages, max_tokens: captured.update(messages=messages) or '{"decision":"pass","text":"ok"}',
            )
            result = await module._run_agent({"task_prompt": "Review", "media": [{"path": "sample.png"}]}, runtime)
            self.assertEqual(result["decision"], "pass")
            data_url = captured["messages"][1]["content"][1]["image_url"]["url"]
            self.assertEqual(len(data_url.split(",", 1)[1]), 4 * ((12 * 1024 * 1024 + 2) // 3))

            image.write_bytes(b"x" * (module.AGENT_MAX_MEDIA_BYTES + 1))
            with self.assertRaises(PluginError) as too_large:
                await module._run_agent({"task_prompt": "Review", "media": [{"path": "sample.png"}]}, runtime)
            self.assertEqual(too_large.exception.status_code, 422)

    async def test_llm_condition_accepts_only_zero_or_one(self):
        runtime = PluginRuntime(
            "infinite-canvas", {}, self.context, self.project, None,
            _call_model=lambda messages, max_tokens: '{"value":1}',
        )
        result = await module.execute({"action": {"id": "infinite-canvas.condition-run"}, "inputs": {
            "text": "画面清晰，主体完整", "rule": "符合要求输出 1，否则输出 0",
        }}, runtime)
        self.assertEqual(result, {"value": 1})
        self.assertEqual(module._condition_value("0"), 0)
        with self.assertRaises(ValueError):
            module._condition_value('{"value":2}')
        for invalid in ('{"value":[]}', '{"value":{}}', '[0,1]', 'true'):
            with self.assertRaises(ValueError):
                module._condition_value(invalid)

    async def test_allows_multiple_links_for_node_plugins_with_multiple_inputs(self):
        value = workflow()
        value["nodes"].insert(1, {"id": "node-source2", "type": "test.source", "position": {"x": 0, "y": 160}, "config": {}, "values": {}})
        value["edges"].append({"id": "edge-second", "from": {"node": "node-source2", "port": "out"}, "to": {"node": "node-target", "port": "in"}})
        result = await self.call("save", {"workflow": value, "expected_revision": 0})
        self.assertEqual(len(result["workflow"]["edges"]), 2)

    async def test_rejects_duplicate_edge_pair(self):
        value = workflow()
        value["edges"].append({"id": "edge-copy", **value["edges"][0]})
        value["edges"][1]["id"] = "edge-copy"
        with self.assertRaises(PluginError) as caught:
            await self.call("save", {"workflow": value, "expected_revision": 0})
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("重复连线", str(caught.exception))

    async def test_project_isolation(self):
        await self.call("save", {"workflow": workflow(), "expected_revision": 0})
        other = self.service.create("Other")['id']
        self.assertEqual((await self.call("list", project=other))["items"], [])
        with self.assertRaises(PluginError):
            await self.call("get", {"workflow_id": "workflow-test01"}, project=other)

    def test_manifest_and_built_ui(self):
        manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
        schema = json.loads((ROOT.parents[1] / "docs" / "schemas" / "plugin-manifest-v1.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(manifest)
        built = ROOT / "ui" / "dist" / "index.js"
        self.assertTrue(built.is_file())
        checked = subprocess.run(["node", "--check", str(built)], capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        source = (ROOT / "ui" / "CanvasApplication.js").read_text(encoding="utf-8")
        self.assertNotIn("confirm(", source)
        self.assertIn("/canvas-nodes", source)
        self.assertIn("/capabilities?operation=generate", source)
        self.assertIn("/plugin-actions?automation=true", source)


if __name__ == "__main__":
    unittest.main()
