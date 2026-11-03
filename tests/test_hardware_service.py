from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.integrations.system_services import SystemServiceRegistry
from backend.persistence.database import Database


ROOT = Path(__file__).resolve().parents[1]
SERVICES = ROOT / "backend" / "integrations" / "system_services"


class HardwareServiceTests(unittest.TestCase):
    def test_local_hardware_provider_is_discovered_and_schema_valid(self):
        registry = SystemServiceRegistry(SERVICES)

        self.assertEqual(registry.errors, [])
        self.assertTrue(registry.contains("local", "hardware"))
        result = registry.invoke("hardware", "snapshot", {})

        self.assertEqual(result["scope"], "gateway_host")
        self.assertIn("logical_cores", result["cpu"])
        self.assertIn("total_bytes", result["memory"])
        self.assertIsInstance(result["gpus"], list)
        self.assertIsInstance(result["warnings"], list)

    def test_nvidia_probe_parses_multiple_gpus_without_shell(self):
        provider = SystemServiceRegistry(SERVICES).get("local", "hardware")
        completed = type("Completed", (), {
            "returncode": 0,
            "stdout": "0, NVIDIA RTX 4090, 24564, 20000\n1, NVIDIA RTX 3060, 12288, 8000\n",
        })()
        with patch("shutil.which", return_value="nvidia-smi"), patch("subprocess.run", return_value=completed) as run:
            result = provider._nvidia_gpus()

        self.assertEqual([item["index"] for item in result], [0, 1])
        self.assertEqual(result[0]["total_memory_bytes"], 24564 * 1024 * 1024)
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs["timeout"], 4)

    def test_missing_probes_return_unknown_values_instead_of_failing(self):
        provider = SystemServiceRegistry(SERVICES).get("local", "hardware")
        with patch.object(provider, "_cpu", return_value={
                "name": None, "logical_cores": None, "physical_cores": None,
             }), patch.object(provider, "_memory", return_value={
                "total_bytes": None, "available_bytes": None,
             }), patch.object(provider, "_gpus", return_value=[]):
            result = provider._snapshot()

        self.assertEqual(result["memory"]["total_bytes"], None)
        self.assertEqual(set(result["warnings"]), {
            "cpu_details_unavailable", "memory_details_unavailable", "gpu_details_unavailable",
        })

    def test_virtual_display_adapters_are_not_reported_as_gpus(self):
        provider = SystemServiceRegistry(SERVICES).get("local", "hardware")
        self.assertTrue(provider._physical_display_adapter({
            "name": "NVIDIA GeForce RTX", "pnp_device_id": "PCI\\VEN_10DE",
        }))
        self.assertFalse(provider._physical_display_adapter({
            "name": "GameViewer Virtual Display Adapter", "pnp_device_id": "ROOT\\DISPLAY0000",
        }))


class CollaborationConditionalUpdateTests(unittest.TestCase):
    def test_cancelled_collaboration_rejects_late_worker_update(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "test.sqlite")
            db.initialize({})
            db.create_collaboration({
                "id": "collaboration-race", "capability_id": "video.reference",
                "model_id": "model", "mode_id": "reference", "request": {}, "status": "running",
            })
            db.update_collaboration("collaboration-race", {"status": "cancelled"}, expected_statuses=("running",))

            result = db.update_collaboration(
                "collaboration-race", {"status": "awaiting_confirmation", "revision": 1},
                expected_statuses=("running",),
            )

            self.assertEqual(result["status"], "cancelled")
            self.assertEqual(result["revision"], 0)


if __name__ == "__main__":
    unittest.main()
