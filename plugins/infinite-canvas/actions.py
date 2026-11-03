"""Project-scoped persistence for shareable infinite-canvas workflows."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import asyncio
import base64
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import tempfile
from urllib import error as urlerror
from urllib import request as urlrequest

from backend.modules.shared.plugin_runtime import PluginError


WORKFLOW_ID = re.compile(r"^workflow-[A-Za-z0-9_-]{6,80}$")
NODE_ID = re.compile(r"^node-[A-Za-z0-9_-]{4,80}$")
EDGE_ID = re.compile(r"^edge-[A-Za-z0-9_-]{4,80}$")
NODE_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,239}$")
PORT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$")
MAX_JSON_BYTES = 2_000_000
MAX_NODES = 500
MAX_EDGES = 2000
SKILLS_ROOT = Path(__file__).resolve().parent / "nodes" / "agent" / "skills"
EDGE_KINDS = {"data", "control", "loop"}
AGENT_MAX_TOKENS = 2500
AGENT_MAX_MEDIA_BYTES = 20 * 1024 * 1024
AGENT_TIMEOUT_SECONDS = 90
AGENT_TEMPERATURE = 0.2
AGENT_SYSTEM_ROLE = "你是 VideoFree Studio 无限画布中的可靠创作智能体。严格按照所选技能与用户任务执行。"


def _document_id(workflow_id: str) -> str:
    return f"canvas:{workflow_id}"


def _workflow_directory(app, project_id: str) -> Path:
    plugin_root = Path(app.directory(project_id)).resolve()
    directory = plugin_root / "work"
    if directory.is_symlink():
        raise PluginError(422, "工作流目录不能是符号链接")
    directory.mkdir(parents=True, exist_ok=True)
    resolved = directory.resolve()
    if plugin_root not in resolved.parents:
        raise PluginError(422, "工作流目录无效")
    return resolved


def _workflow_paths(app, project_id: str, workflow_id: str) -> tuple[Path, Path]:
    directory = _workflow_directory(app, project_id)
    return directory / f"{workflow_id}.json", directory / f".{workflow_id}.revision"


def _read_workflow_file(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise PluginError(404, "工作流不存在")
    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            raise PluginError(422, "工作流 JSON 不能超过 2 MB")
        return _validate_workflow(json.loads(path.read_text(encoding="utf-8")))
    except PluginError:
        raise
    except (OSError, UnicodeError, ValueError) as exc:
        raise PluginError(422, f"工作流 JSON 无法读取：{path.name}") from exc


def _atomic_write(path: Path, content: bytes) -> None:
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    except OSError as exc:
        raise PluginError(500, f"无法保存工作流文件：{path.name}") from exc
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink(missing_ok=True)


def _file_revision(path: Path, metadata_path: Path) -> int:
    if not path.exists():
        return 0
    if metadata_path.is_symlink():
        raise PluginError(422, "工作流修订记录无效")
    try:
        return max(1, int(metadata_path.read_text(encoding="ascii"))) if metadata_path.is_file() else 1
    except (OSError, UnicodeError, ValueError) as exc:
        raise PluginError(422, "工作流修订记录无法读取") from exc


def _file_document(path: Path, revision_path: Path, project_id: str) -> dict:
    workflow = _read_workflow_file(path)
    return {
        "id": _document_id(workflow["id"]),
        "project_id": project_id,
        "category_id": "",
        "document_type": "workflow",
        "schema_version": 1,
        "revision": _file_revision(path, revision_path),
        "updated_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
        "workflow": workflow,
    }


def _stored_workflows(app, project_id: str) -> dict[str, dict]:
    result = {}
    directory = _workflow_directory(app, project_id)
    for path in directory.glob("workflow-*.json"):
        if path.is_symlink() or not path.is_file():
            continue
        workflow_id = path.stem
        if not WORKFLOW_ID.fullmatch(workflow_id):
            continue
        revision_path = path.with_name(f".{path.name[:-5]}.revision")
        result[workflow_id] = _file_document(path, revision_path, project_id)
    # Older database records remain readable until the user saves them again.
    for workflow_id, document in _legacy_workflows(app, project_id).items():
        result.setdefault(workflow_id, document)
    return result


def _legacy_workflow(app, project_id: str, workflow_id: str):
    return app.document(project_id, _document_id(workflow_id), None)


def _legacy_workflows(app, project_id: str) -> dict[str, dict]:
    return {
        item["id"].removeprefix("canvas:"): item
        for item in app.documents(project_id, None)
        if isinstance(item.get("id"), str)
        and item["id"].startswith("canvas:workflow-")
        and WORKFLOW_ID.fullmatch(item["id"].removeprefix("canvas:"))
    }


def _finite_number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise PluginError(422, f"{label} 必须是有限数字")
    return float(value)


def _plain_object(value, label: str) -> dict:
    if not isinstance(value, dict):
        raise PluginError(422, f"{label} 必须是对象")
    return value


def _validate_workflow(raw) -> dict:
    workflow = deepcopy(_plain_object(raw, "workflow"))
    try:
        encoded = json.dumps(workflow, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PluginError(422, "工作流必须是有效 JSON") from exc
    if len(encoded) > MAX_JSON_BYTES:
        raise PluginError(422, "工作流 JSON 不能超过 2 MB")
    allowed = {"schema_version", "kind", "id", "name", "nodes", "edges", "viewport"}
    if set(workflow) - allowed:
        raise PluginError(422, "workflow 包含未知字段")
    if workflow.get("schema_version") != 1 or workflow.get("kind") != "videofree.infinite-canvas":
        raise PluginError(422, "工作流格式或版本不受支持")
    workflow_id = workflow.get("id")
    if not isinstance(workflow_id, str) or not WORKFLOW_ID.fullmatch(workflow_id):
        raise PluginError(422, "工作流 ID 无效")
    name = workflow.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
        raise PluginError(422, "工作流名称应为 1-120 个字符")
    workflow["name"] = name.strip()

    nodes = workflow.get("nodes")
    edges = workflow.get("edges")
    if not isinstance(nodes, list) or len(nodes) > MAX_NODES:
        raise PluginError(422, f"nodes 必须是数组且不能超过 {MAX_NODES} 项")
    if not isinstance(edges, list) or len(edges) > MAX_EDGES:
        raise PluginError(422, f"edges 必须是数组且不能超过 {MAX_EDGES} 项")

    node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        node = _plain_object(node, f"nodes[{index}]")
        allowed = {"id", "type", "position", "config", "values", "label"}
        if set(node) - allowed:
            raise PluginError(422, f"nodes[{index}] 包含未知字段")
        node_id, node_type = node.get("id"), node.get("type")
        if not isinstance(node_id, str) or not NODE_ID.fullmatch(node_id) or node_id in node_ids:
            raise PluginError(422, f"nodes[{index}].id 无效或重复")
        if not isinstance(node_type, str) or not NODE_TYPE.fullmatch(node_type):
            raise PluginError(422, f"nodes[{index}].type 无效")
        position = _plain_object(node.get("position"), f"nodes[{index}].position")
        if set(position) != {"x", "y"}:
            raise PluginError(422, f"nodes[{index}].position 必须只包含 x/y")
        position["x"] = _finite_number(position["x"], f"nodes[{index}].position.x")
        position["y"] = _finite_number(position["y"], f"nodes[{index}].position.y")
        for field in ("config", "values"):
            _plain_object(node.get(field, {}), f"nodes[{index}].{field}")
            node.setdefault(field, {})
        if "label" in node and (not isinstance(node["label"], str) or len(node["label"]) > 120):
            raise PluginError(422, f"nodes[{index}].label 无效")
        node_ids.add(node_id)

    edge_ids: set[str] = set()
    edge_pairs: set[tuple[str, str, str, str]] = set()
    adjacency = {node_id: [] for node_id in node_ids}
    for index, edge in enumerate(edges):
        edge = _plain_object(edge, f"edges[{index}]")
        if set(edge) - {"id", "from", "to", "kind"}:
            raise PluginError(422, f"edges[{index}] 字段无效")
        kind = edge.get("kind", "data")
        if kind not in EDGE_KINDS:
            raise PluginError(422, f"edges[{index}].kind 无效")
        edge["kind"] = kind
        edge_id = edge.get("id")
        if not isinstance(edge_id, str) or not EDGE_ID.fullmatch(edge_id) or edge_id in edge_ids:
            raise PluginError(422, f"edges[{index}].id 无效或重复")
        endpoints = []
        for side in ("from", "to"):
            endpoint = _plain_object(edge.get(side), f"edges[{index}].{side}")
            if set(endpoint) != {"node", "port"} or endpoint.get("node") not in node_ids:
                raise PluginError(422, f"edges[{index}].{side} 引用了无效节点")
            port = endpoint.get("port")
            if not isinstance(port, str) or not PORT_ID.fullmatch(port):
                raise PluginError(422, f"edges[{index}].{side}.port 无效")
            endpoints.append((endpoint["node"], port))
        source, target = endpoints
        if source[0] == target[0]:
            raise PluginError(422, "节点不能连接到自身")
        pair = (source[0], source[1], target[0], target[1])
        if pair in edge_pairs:
            raise PluginError(422, "工作流不能包含重复连线")
        if kind in {"data", "control"}:
            adjacency[source[0]].append(target[0])
        edge_ids.add(edge_id)
        edge_pairs.add(pair)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str):
        if node_id in visiting:
            raise PluginError(422, "工作流不能包含循环连接")
        if node_id in visited:
            return
        visiting.add(node_id)
        for target in adjacency[node_id]:
            visit(target)
        visiting.remove(node_id)
        visited.add(node_id)

    for node_id in node_ids:
        visit(node_id)

    viewport = _plain_object(workflow.get("viewport", {"x": 0, "y": 0, "zoom": 1}), "viewport")
    if set(viewport) != {"x", "y", "zoom"}:
        raise PluginError(422, "viewport 必须只包含 x/y/zoom")
    viewport["x"] = _finite_number(viewport["x"], "viewport.x")
    viewport["y"] = _finite_number(viewport["y"], "viewport.y")
    viewport["zoom"] = _finite_number(viewport["zoom"], "viewport.zoom")
    if not 0.1 <= viewport["zoom"] <= 4:
        raise PluginError(422, "viewport.zoom 必须在 0.1-4 之间")
    workflow["viewport"] = viewport
    return workflow


def _agent_skills() -> list[dict]:
    items = []
    if not SKILLS_ROOT.is_dir():
        return items
    for manifest_path in sorted(SKILLS_ROOT.glob("*/skill.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        skill_id = manifest.get("id")
        instructions_path = manifest_path.parent / "SKILL.md"
        if not isinstance(skill_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", skill_id):
            continue
        if not instructions_path.is_file():
            continue
        items.append({
            "id": skill_id,
            "name": str(manifest.get("name") or skill_id),
            "name_en": str(manifest.get("name_en") or manifest.get("name") or skill_id),
            "description": str(manifest.get("description") or ""),
            "description_en": str(manifest.get("description_en") or manifest.get("description") or ""),
        })
    return items


def _skill_instructions(skill_id: str) -> str:
    for item in _agent_skills():
        if item["id"] == skill_id:
            return (SKILLS_ROOT / skill_id / "SKILL.md").read_text(encoding="utf-8")
    raise PluginError(422, "所选智能体技能不存在")


def _strip_json_fence(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _agent_result(raw: str) -> dict:
    try:
        parsed = json.loads(_strip_json_fence(raw))
    except (TypeError, ValueError) as exc:
        raise ValueError("智能体没有返回有效 JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("智能体结果必须是对象")
    decision = str(parsed.get("decision") or "pass").lower()
    if decision not in {"pass", "retry", "fail"}:
        raise ValueError("decision 必须是 pass、retry 或 fail")
    score = parsed.get("score")
    if score is not None and (isinstance(score, bool) or not isinstance(score, (int, float))):
        raise ValueError("score 必须是数字或 null")
    return {
        "decision": decision,
        "text": str(parsed.get("text") or ""),
        "result": parsed.get("result"),
        "score": score,
        "reason": str(parsed.get("reason") or ""),
        "retry_prompt": str(parsed.get("retry_prompt") or ""),
    }


def _custom_chat(values: dict, messages: list[dict]) -> str:
    base = str(values.get("api_url") or "").strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise PluginError(422, "自定义 LLM API URL 必须以 http:// 或 https:// 开头")
    endpoint = base if base.endswith("/chat/completions") else f"{base}/chat/completions"
    model = str(values.get("model") or "").strip()
    if not model:
        raise PluginError(422, "自定义 LLM 必须填写模型名")
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": AGENT_TEMPERATURE,
        "max_tokens": AGENT_MAX_TOKENS,
    }, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if values.get("api_key"):
        headers["Authorization"] = f"Bearer {values['api_key']}"
    timeout = AGENT_TIMEOUT_SECONDS
    last_error = None
    for attempt in range(3):
        try:
            with urlrequest.urlopen(urlrequest.Request(endpoint, data=payload, headers=headers, method="POST"), timeout=timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
            return str(body["choices"][0]["message"]["content"])
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            if exc.code not in {429, 500, 502, 503, 504}:
                raise PluginError(502, f"自定义 LLM 请求失败（HTTP {exc.code}）：{detail}") from exc
            last_error = f"HTTP {exc.code}: {detail}"
        except (OSError, ValueError, KeyError, IndexError) as exc:
            last_error = str(exc)
        if attempt < 2:
            import time
            time.sleep(0.5 * (2 ** attempt))
    raise PluginError(502, f"自定义 LLM 暂时不可用：{last_error or 'unknown error'}")


async def _run_agent(values: dict, runtime) -> dict:
    skill_id = str(values.get("skill_id") or "general")
    skill = _skill_instructions(skill_id)
    task = str(values.get("task_prompt") or "").strip()
    if not task:
        raise PluginError(422, "智能体任务不能为空")
    contract = (
        "Return only one JSON object with keys: decision (pass|retry|fail), text (string), "
        "result (any JSON value), score (number or null), reason (string), retry_prompt (string)."
    )
    task_text = f"Task:\n{task}"
    user_content: list[dict] = [{"type": "text", "text": task_text}]
    media_values = values.get("media") or []
    if not isinstance(media_values, list):
        media_values = [media_values]
    if len(media_values) > 8:
        raise PluginError(422, "智能体最多接收 8 个素材")
    total_media_bytes = 0
    for media in media_values:
        relative_path = media.get("path") or media.get("project_path") if isinstance(media, dict) else None
        if not isinstance(relative_path, str) or not relative_path.strip():
            raise PluginError(422, "智能体素材缺少有效的项目文件路径")
        try:
            path = runtime.application.resolve_library_path(runtime.project_id, relative_path)
            if not path.is_file():
                raise PluginError(422, "智能体素材必须是项目内的普通文件")
            remaining_bytes = AGENT_MAX_MEDIA_BYTES - total_media_bytes
            if path.stat().st_size > remaining_bytes:
                raise PluginError(422, "智能体媒体总大小不能超过 20 MB")
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if not mime.startswith(("image/", "video/", "audio/")):
                raise PluginError(422, f"智能体不支持此素材类型：{path.name}")
            with path.open("rb") as media_file:
                data = media_file.read(remaining_bytes + 1)
            if len(data) > remaining_bytes:
                raise PluginError(422, "智能体媒体总大小不能超过 20 MB")
            total_media_bytes += len(data)
            encoded = base64.b64encode(data).decode("ascii")
        except PluginError:
            raise
        except (OSError, ValueError) as exc:
            raise PluginError(422, "智能体素材不存在或无法读取") from exc
        data_url = f"data:{mime};base64,{encoded}"
        if mime.startswith("image/"):
            user_content.append({"type": "image_url", "image_url": {"url": data_url}})
        elif mime.startswith("video/"):
            user_content.append({"type": "video_url", "video_url": {"url": data_url}})
        elif mime.startswith("audio/"):
            user_content.append({"type": "input_audio", "input_audio": {"data": encoded, "format": path.suffix.lower().lstrip(".") or "wav"}})
    messages = [
        {"role": "system", "content": f"{AGENT_SYSTEM_ROLE}\n\nSkill instructions:\n{skill}\n\n{contract}"},
        {"role": "user", "content": user_content},
    ]
    source = str(values.get("llm_source") or "system")
    if source == "custom":
        raw = await asyncio.to_thread(_custom_chat, values, messages)
    elif source == "system":
        raw = await asyncio.to_thread(runtime.call_model, messages, AGENT_MAX_TOKENS)
    else:
        raise PluginError(422, "llm_source 只能是 system 或 custom")
    try:
        return _agent_result(raw)
    except ValueError:
        repair = messages + [
            {"role": "assistant", "content": str(raw)},
            {"role": "user", "content": f"Your previous response violated the output contract. {contract}"},
        ]
        repaired = await asyncio.to_thread(_custom_chat, values, repair) if source == "custom" else await asyncio.to_thread(runtime.call_model, repair, AGENT_MAX_TOKENS)
        try:
            return _agent_result(repaired)
        except ValueError as exc:
            raise PluginError(502, str(exc)) from exc


def _condition_value(raw: str) -> int:
    text = _strip_json_fence(str(raw))
    if text in {"0", "1"}:
        return int(text)
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise ValueError("LLM 条件判断没有返回 0 或 1") from exc
    value = parsed.get("value") if isinstance(parsed, dict) else parsed
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value not in (0, 1):
        raise ValueError("LLM 条件判断结果必须是 0 或 1")
    return int(value)


async def _run_condition(values: dict, runtime) -> dict:
    text = str(values.get("text") or "").strip()
    rule = str(values.get("rule") or "").strip()
    if not text:
        raise PluginError(422, "LLM 条件判断缺少上游字符串")
    if not rule:
        raise PluginError(422, "LLM 条件判断缺少判断规则")
    messages = [
        {"role": "system", "content": "你是工作流条件判断器。严格依据规则判断输入，只返回 JSON：{\"value\":0} 或 {\"value\":1}。不要输出其他内容。"},
        {"role": "user", "content": f"判断规则：\n{rule}\n\n上游字符串：\n{text}"},
    ]
    raw = await asyncio.to_thread(runtime.call_model, messages, 256)
    try:
        return {"value": _condition_value(raw)}
    except ValueError:
        repair = messages + [
            {"role": "assistant", "content": str(raw)},
            {"role": "user", "content": "格式错误。现在只返回 {\"value\":0} 或 {\"value\":1}。"},
        ]
        repaired = await asyncio.to_thread(runtime.call_model, repair, 256)
        try:
            return {"value": _condition_value(repaired)}
        except ValueError as exc:
            raise PluginError(502, str(exc)) from exc


def _summary(document: dict) -> dict:
    workflow = document.get("workflow") or {}
    return {
        "id": workflow.get("id"),
        "name": workflow.get("name", ""),
        "revision": int(document.get("revision", 0)),
        "updated_at": document.get("updated_at"),
        "node_count": len(workflow.get("nodes") or []),
        "edge_count": len(workflow.get("edges") or []),
    }


async def execute(request, runtime):
    if not runtime.project_id:
        raise PluginError(422, "当前调用没有项目")
    action = request["action"]["id"].rsplit(".", 1)[-1]
    values = request.get("inputs") or {}
    app, project_id = runtime.application, runtime.project_id

    if action == "import-asset":
        try:
            return app.import_upload(
                values.get("upload_id"), project_id=project_id,
                category_id=runtime.category_id,
                name=values.get("name", ""), kind=values.get("kind"),
            )
        except ValueError as exc:
            raise PluginError(422, str(exc)) from exc

    if action == "agent-skills":
        return {"items": _agent_skills()}

    if action == "agent-run":
        return await _run_agent(values, runtime)

    if action == "condition-run":
        return await _run_condition(values, runtime)

    if action == "list":
        items = [_summary(item) for item in _stored_workflows(app, project_id).values()]
        items.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
        return {"items": items}

    workflow_id = values.get("workflow_id")
    if action == "save":
        workflow = _validate_workflow(values.get("workflow"))
        workflow_id = workflow["id"]
    if not isinstance(workflow_id, str) or not WORKFLOW_ID.fullmatch(workflow_id):
        raise PluginError(422, "工作流 ID 无效")
    document_id = _document_id(workflow_id)
    stored = _stored_workflows(app, project_id)
    current = stored.get(workflow_id)

    if action == "get":
        if not current:
            raise PluginError(404, "工作流不存在")
        return {"workflow": current["workflow"], "revision": current["revision"], "updated_at": current["updated_at"]}

    if action == "delete":
        if not current:
            raise PluginError(404, "工作流不存在")
        if values["expected_revision"] != int(current.get("revision", 0)):
            raise PluginError(409, "工作流已被其他调用更新，请重新载入")
        path, revision_path = _workflow_paths(app, project_id, workflow_id)
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise PluginError(422, "工作流文件无效")
        try:
            path.unlink(missing_ok=True)
            revision_path.unlink(missing_ok=True)
        except OSError as exc:
            raise PluginError(500, "无法删除工作流文件") from exc
        # Remove a legacy record too, so deletion is complete after migration.
        if app.document(project_id, document_id, None):
            app.delete(project_id, document_id, None)
        return {"deleted": True, "workflow_id": workflow_id}

    if action != "save":
        raise PluginError(422, "未知的无限画布操作")
    revision = int((current or {}).get("revision", 0))
    if values["expected_revision"] != revision:
        raise PluginError(409, "工作流已被其他调用更新，请重新载入；本地修改未丢失")
    now = datetime.now(timezone.utc).isoformat()
    path, revision_path = _workflow_paths(app, project_id, workflow_id)
    if path.exists() and path.is_symlink():
        raise PluginError(422, "工作流文件不能是符号链接")
    _atomic_write(path, json.dumps(workflow, ensure_ascii=False, indent=2).encode("utf-8"))
    _atomic_write(revision_path, str(revision + 1).encode("ascii"))
    return {"workflow": workflow, "revision": revision + 1, "updated_at": now}
