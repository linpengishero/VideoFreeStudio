from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from backend.integrations.system_services import SystemServiceRegistry
from backend.integrations.system_services.comfyui import load_provider
from backend.modules.shared.plugin_runtime import PluginRuntime


ROOT = Path(__file__).resolve().parents[1]
SERVICES = ROOT / "backend" / "integrations" / "system_services"


class ComfyUISystemServiceTests(unittest.TestCase):
    def test_registered_operation_reads_and_normalizes_configured_comfyui_stats(self):
        provider = load_provider("http://comfyui.example")
        provider.request = Mock(return_value={
            "system": {"comfyui_version": "0.3.50"},
            "devices": [{
                "name": "NVIDIA GeForce RTX 4090", "type": "cuda", "index": 0,
                "vram_total": 25757220864, "vram_free": 21474836480,
                "torch_vram_total": 0, "torch_vram_free": 0,
            }],
        })
        context = SimpleNamespace(comfyui_provider=provider, db=SimpleNamespace(settings=lambda: {}))
        runtime = PluginRuntime("test-plugin", {}, context)
        context.system_services = SystemServiceRegistry(SERVICES)

        stats = runtime.call_system_service("comfyui", "system_stats", {})

        self.assertEqual(stats, {
            "scope": "comfyui_host",
            "comfyui_version": "0.3.50",
            "devices": [{
                "name": "NVIDIA GeForce RTX 4090", "type": "cuda", "index": 0,
                "total_memory_bytes": 25757220864,
                "free_memory_bytes": 21474836480,
            }],
        })
        provider.request.assert_called_once_with("/system_stats")

    def test_invalid_stats_response_fails_as_a_service_error(self):
        provider = load_provider("http://comfyui.example")
        provider.request = Mock(return_value={"system": {}, "devices": "not-a-list"})
        context = SimpleNamespace(comfyui_provider=provider, db=SimpleNamespace(settings=lambda: {}))
        context.system_services = SystemServiceRegistry(SERVICES)
        runtime = PluginRuntime("test-plugin", {}, context)

        with self.assertRaisesRegex(Exception, "provider_failed"):
            runtime.call_system_service("comfyui", "system_stats", {})


if __name__ == "__main__":
    unittest.main()
