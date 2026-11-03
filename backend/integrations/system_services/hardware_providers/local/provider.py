# Copyright (c) 2026 VideoFree Studio individual project author and contributors.
# Part of VideoFree Studio: https://github.com/linpengishero/VideoFreeStudio
# Licensed under the GNU Affero General Public License v3.0; see LICENSE and NOTICE.
# Separate commercial licensing may be available; see COMMERCIAL_LICENSE.md.

"""Read-only, dependency-free hardware snapshot for the gateway host."""

from __future__ import annotations

import ctypes
import csv
from datetime import datetime, timezone
import io
import json
import os
import platform
import re
import shutil
import subprocess
from typing import Any


_WINDOWS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_WINDOWS_CIM_SCRIPT = (
    "$cpu=@(Get-CimInstance -ClassName Win32_Processor | ForEach-Object {"
    "[ordered]@{name=$_.Name;physical_cores=[int]$_.NumberOfCores}});"
    "$gpu=@(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {"
    "[ordered]@{name=$_.Name;pnp_device_id=$_.PNPDeviceID}});"
    "[ordered]@{cpu=$cpu;gpu=$gpu} | ConvertTo-Json -Compress -Depth 4"
)


class Provider:
    def __init__(self, manifest: dict[str, Any]):
        self.manifest = manifest

    def invoke(self, operation: str, inputs: dict[str, Any], settings: dict[str, Any], *, context) -> dict[str, Any]:
        if operation != "snapshot":
            raise ValueError("Unsupported hardware operation")
        return self._snapshot()

    def _snapshot(self) -> dict[str, Any]:
        system = platform.system() or "Unknown"
        windows_details = self._windows_cim() if system == "Windows" else None
        cpu = self._cpu(system, windows_details)
        memory = self._memory(system)
        gpus = self._gpus(system, windows_details)
        warnings = []
        if cpu["name"] is None and cpu["logical_cores"] is None:
            warnings.append("cpu_details_unavailable")
        if memory["total_bytes"] is None:
            warnings.append("memory_details_unavailable")
        if not gpus:
            warnings.append("gpu_details_unavailable")
        elif any(gpu["total_memory_bytes"] is None for gpu in gpus):
            warnings.append("gpu_memory_unavailable")
        return {
            "scope": "gateway_host",
            "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "platform": {"system": system, "architecture": platform.machine() or "Unknown"},
            "cpu": cpu,
            "memory": memory,
            "gpus": gpus,
            "warnings": warnings,
        }

    @staticmethod
    def _cpu(system: str, windows_details: dict[str, Any] | None = None) -> dict[str, Any]:
        name = None
        physical = None
        if system == "Windows":
            details = windows_details if windows_details is not None else Provider._windows_cim()
            cpus = Provider._as_list(details.get("cpu")) if details else []
            names = [str(item.get("name", "")).strip() for item in cpus if isinstance(item, dict)]
            name = next((item for item in names if item), None)
            cores = [item.get("physical_cores") for item in cpus if isinstance(item, dict)]
            cores = [value for value in cores if isinstance(value, int) and value > 0]
            physical = sum(cores) or None
            name = name or os.environ.get("PROCESSOR_IDENTIFIER") or None
        elif system == "Linux":
            try:
                with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as handle:
                    text = handle.read()
                blocks = re.split(r"\n\s*\n", text)
                identities = set()
                for block in blocks:
                    fields = dict(line.split(":", 1) for line in block.splitlines() if ":" in line)
                    name = name or fields.get("model name", "").strip() or fields.get("Hardware", "").strip() or None
                    if "physical id" in fields and "core id" in fields:
                        identities.add((fields["physical id"].strip(), fields["core id"].strip()))
                physical = len(identities) or None
            except OSError:
                pass
        elif system == "Darwin":
            name = Provider._command_text(["sysctl", "-n", "machdep.cpu.brand_string"], timeout=2)
            value = Provider._command_text(["sysctl", "-n", "hw.physicalcpu"], timeout=2)
            physical = Provider._positive_integer(value)
        name = name or platform.processor() or None
        return {"name": name, "logical_cores": os.cpu_count(), "physical_cores": physical}

    @staticmethod
    def _memory(system: str) -> dict[str, int | None]:
        total = available = None
        if system == "Windows":
            try:
                class MemoryStatus(ctypes.Structure):
                    _fields_ = [
                        ("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                        ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                        ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                        ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                        ("ullAvailExtendedVirtual", ctypes.c_uint64),
                    ]
                status = MemoryStatus()
                status.dwLength = ctypes.sizeof(status)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                    total, available = int(status.ullTotalPhys), int(status.ullAvailPhys)
            except (AttributeError, OSError):
                pass
        elif system == "Linux":
            try:
                values = {}
                with open("/proc/meminfo", encoding="ascii") as handle:
                    for line in handle:
                        key, _, raw = line.partition(":")
                        if key in {"MemTotal", "MemAvailable"}:
                            values[key] = int(raw.strip().split()[0]) * 1024
                total, available = values.get("MemTotal"), values.get("MemAvailable")
            except (OSError, ValueError, IndexError):
                pass
        elif system == "Darwin":
            total = Provider._positive_integer(Provider._command_text(["sysctl", "-n", "hw.memsize"], timeout=2))
        return {"total_bytes": total, "available_bytes": available}

    @staticmethod
    def _gpus(system: str, windows_details: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        nvidia = Provider._nvidia_gpus()
        names = []
        if system == "Windows":
            details = windows_details if windows_details is not None else Provider._windows_cim()
            values = Provider._as_list(details.get("gpu")) if details else []
            names = [str(item.get("name", "")).strip() for item in values
                     if isinstance(item, dict) and Provider._physical_display_adapter(item)]
        result = list(nvidia)
        known = {item["name"].casefold() for item in nvidia}
        used_indexes = {item["index"] for item in nvidia}
        for name in names:
            if name and name.casefold() not in known:
                index = 0
                while index in used_indexes:
                    index += 1
                result.append({
                    "index": index, "name": name,
                    "total_memory_bytes": None, "free_memory_bytes": None,
                })
                used_indexes.add(index)
                known.add(name.casefold())
        return result

    @staticmethod
    def _nvidia_gpus() -> list[dict[str, Any]]:
        executable = shutil.which("nvidia-smi")
        if not executable:
            return []
        try:
            result = subprocess.run(
                [executable, "--query-gpu=index,name,memory.total,memory.free", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=4, check=False, creationflags=_WINDOWS_NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        if result.returncode != 0:
            return []
        gpus = []
        for row in csv.reader(io.StringIO(result.stdout)):
            if len(row) < 4:
                continue
            index = Provider._nonnegative_integer(row[0])
            name = row[1].strip()
            if index is None or not name:
                continue
            total = Provider._positive_integer(row[2])
            free = Provider._positive_integer(row[3])
            gpus.append({
                "index": index,
                "name": name,
                "total_memory_bytes": total * 1024 * 1024 if total is not None else None,
                "free_memory_bytes": free * 1024 * 1024 if free is not None else None,
            })
        return gpus

    @staticmethod
    def _windows_cim() -> dict[str, Any]:
        if os.name != "nt":
            return {}
        executable = shutil.which("powershell.exe") or shutil.which("powershell")
        if not executable:
            return {}
        try:
            result = subprocess.run(
                [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", _WINDOWS_CIM_SCRIPT],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=5, check=False, creationflags=_WINDOWS_NO_WINDOW,
            )
            if result.returncode == 0:
                parsed = json.loads(result.stdout)
                return parsed if isinstance(parsed, dict) else {}
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
        return {}

    @staticmethod
    def _command_text(command: list[str], *, timeout: int) -> str | None:
        executable = shutil.which(command[0])
        if not executable:
            return None
        try:
            result = subprocess.run(
                [executable, *command[1:]], capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=timeout, check=False,
                creationflags=_WINDOWS_NO_WINDOW,
            )
            return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None
        except (OSError, subprocess.TimeoutExpired):
            return None

    @staticmethod
    def _positive_integer(value: Any) -> int | None:
        try:
            parsed = int(str(value).strip())
            return parsed if parsed > 0 else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _nonnegative_integer(value: Any) -> int | None:
        try:
            parsed = int(str(value).strip())
            return parsed if parsed >= 0 else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _as_list(value: Any) -> list[Any]:
        if isinstance(value, list):
            return value
        return [value] if value else []

    @staticmethod
    def _physical_display_adapter(item: dict[str, Any]) -> bool:
        name = str(item.get("name") or "").strip().casefold()
        device_id = str(item.get("pnp_device_id") or "").strip().upper()
        virtual_markers = ("virtual display", "remote display", "idd driver", "basic render")
        return bool(name) and not any(marker in name for marker in virtual_markers) and (
            not device_id or device_id.startswith("PCI\\")
        )
