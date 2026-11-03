# Copyright (c) 2026 VideoFree Studio individual project author and contributors.
# Part of VideoFree Studio: https://github.com/linpengishero/VideoFreeStudio
# Licensed under the GNU Affero General Public License v3.0; see LICENSE and NOTICE.
# Separate commercial licensing may be available; see COMMERCIAL_LICENSE.md.

"""Small MCP-over-HTTP adapter for LAN AI clients.

The adapter exposes discovery, generation, speech and post-processing tools.
It delegates state and validation to the existing v2 API
services instead of reading workflows or calling ComfyUI directly.
"""

import json
import base64
import binascii
import asyncio
import ipaddress
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ...bootstrap import context
from ...core.version import PLATFORM_VERSION
from ...modules.generation.service import workflow_registry
from ...modules.settings import SettingsService
from .v2_capabilities import capability as public_capability
from .dependencies import auth
from .v2_schemas import CreateRequest, RegenerateRequest


MCP_PROTOCOL_VERSION = "2025-06-18"
MCP_SERVER_INFO = {"name": "videofree", "version": PLATFORM_VERSION}
MAX_ARTIFACT_CHUNK_BYTES = 1024 * 1024


def _jsonrpc(request_id: Any, result: Any = None, error: dict[str, Any] | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    return response


def _text(value: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2)}]}


def _local_api_url(path: str) -> str:
    return f"http://127.0.0.1:{context.config.port}{path}"


def _local_api_request(method: str, path: str, body: bytes | None = None, content_type: str = "application/json", idempotency_key: str = "") -> Any:
    headers = {"Accept": "application/json"}
    token = SettingsService.access_token(context)
    if token:
        headers["X-API-Token"] = token
    if body is not None:
        headers["Content-Type"] = content_type
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = urllib.request.Request(_local_api_url(path), data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=45 if "/wait?" in path else 30) as response:
            raw = response.read()
            return json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ValueError(f"网关请求失败 ({exc.code}): {detail}") from exc


async def _local_api(method: str, path: str, value: Any = None) -> Any:
    body = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
    return await asyncio.to_thread(_local_api_request, method, path, body)


def _registry() -> dict[str, dict[str, Any]]:
    workflows_path = context.paths.plugins
    values = {}
    for key, value in workflow_registry().items():
        if value.get("executor", "comfyui") != "comfyui" or (workflows_path / value.get("file", "")).is_file():
            values[key] = value
    return values


def _capabilities(kind: str | None = None, category: str | None = None) -> list[dict[str, Any]]:
    result = []
    for key, config in _registry().items():
        if kind and config.get("kind") != kind:
            continue
        if category and config.get("category") != category:
            continue
        result.append(public_capability(key, config))
    return result


def _tool_definitions() -> list[dict[str, Any]]:
    tools = [
        {
            "name": "list_projects",
            "description": "列出 videofree 中的项目。生成前可先选择当前项目。",
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "create_project",
            "description": "创建项目并返回 project_id。后续生成请显式携带该 project_id；不会改变工作台当前项目。",
            "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}, "description": {"type": "string"}, "content_summary": {"type": "string"}}},
        },
        {
            "name": "get_current_project",
            "description": "读取当前网关选择的项目。",
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "set_current_project",
            "description": "切换当前项目；后续导演协作与生成自动进入该项目。",
            "inputSchema": {"type": "object", "required": ["project_id"], "properties": {"project_id": {"type": "string"}}},
        },
        {
            "name": "list_capabilities",
            "description": "发现网关当前支持的媒体生成和导演协作能力。",
            "inputSchema": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["image", "video", "audio", "tts", "music"]}, "category": {"type": "string", "description": "可选的插件主分类 ID；不传则发现全部能力"}}},
        },
        {
            "name": "get_capability",
            "description": "查询一个能力的完整输入限制、参考素材角色和协作模式。",
            "inputSchema": {"type": "object", "required": ["capability_id"], "properties": {"capability_id": {"type": "string"}}},
        },
        {
            "name": "create_director_collaboration",
            "description": "把普通创作需求交给导演协作管线，返回协作任务 ID；不会自动提交视频。",
            "inputSchema": {
                "type": "object", "required": ["capability_id", "model_id", "mode_id", "message"],
                "properties": {
                    "capability_id": {"type": "string"}, "model_id": {"type": "string"}, "mode_id": {"type": "string"},
                    "message": {"type": "string"}, "collaboration_mode": {"type": "string", "enum": ["quick", "director"]},
                    "inputs": {"type": "array", "items": {"type": "object", "required": ["type", "upload_id"], "properties": {"type": {"type": "string", "enum": ["image", "video", "audio"]}, "upload_id": {"type": "string"}, "role": {"type": "string"}}}}, "settings": {"type": "object"},
                    "project_id": {"type": "string", "description": "可选；省略时使用当前激活项目"},
                    "category_id": {"type": "string", "description": "可选；省略时使用默认分类"},
                },
            },
        },
        {
            "name": "get_collaboration",
            "description": "读取导演协作当前状态、问题、确认稿和进度。",
            "inputSchema": {"type": "object", "required": ["collaboration_id"], "properties": {"collaboration_id": {"type": "string"}}},
        },
        {
            "name": "send_collaboration_message",
            "description": "向现有导演协作任务补充信息或回答追问。",
            "inputSchema": {"type": "object", "required": ["collaboration_id", "message"], "properties": {"collaboration_id": {"type": "string"}, "message": {"type": "string"}}},
        },
        {
            "name": "get_final_prompt",
            "description": "取得导演协作生成的最终英文执行稿和中文确认稿，不提交生成。",
            "inputSchema": {"type": "object", "required": ["collaboration_id"], "properties": {"collaboration_id": {"type": "string"}}},
        },
        {
            "name": "confirm_collaboration",
            "description": "审核通过后确认当前版本并提交。默认必须取得用户明确确认；只有用户明确委托特定镜头的审核及确认时可按授权执行，禁止通用自动确认。",
            "inputSchema": {"type": "object", "required": ["collaboration_id", "revision"], "properties": {"collaboration_id": {"type": "string"}, "revision": {"type": "integer"}, "execution_prompt_en": {"type": "string"}, "confirmed_prompt_zh": {"type": "string"}, "idempotency_key": {"type": "string"}}},
        },
        {
            "name": "upload_reference",
            "description": "上传本机文件或 Base64 素材并返回可复用的 upload_id；二者只能选一个。",
            "inputSchema": {
                "type": "object",
                "properties": {"filename": {"type": "string", "minLength": 1},
                               "data_base64": {"type": "string", "minLength": 1},
                               "file_path": {"type": "string", "minLength": 1,
                                             "description": "仅限通过 127.0.0.1/::1 连接的客户端读取网关本机文件。"},
                               "media_type": {"type": "string"}},
                "oneOf": [
                    {"required": ["filename", "data_base64"], "not": {"required": ["file_path"]}},
                    {"required": ["file_path"], "not": {"required": ["data_base64"]}},
                ],
            },
        },
        {
            "name": "submit_generation",
            "description": "提交已确认的图片、视频、音频或语音生成任务，返回 job_id；会产生实际生成任务。",
            "inputSchema": {"type": "object", "required": ["capability_id", "prompt"], "properties": {"capability_id": {"type": "string"}, "prompt": {"type": "string"}, "lyrics": {"type": "string"}, "inputs": {"type": "array", "items": {"type": "object"}}, "settings": {"type": "object"}, "project_id": {"type": "string", "description": "可选；省略时使用当前激活项目"}, "idempotency_key": {"type": "string"}}},
        },
        {
            "name": "get_job",
            "description": "查询任务状态以及已完成任务的产物 URL。",
            "inputSchema": {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}},
        },
        {
            "name": "wait_job",
            "description": "单次最多等待30秒并返回最新状态；仍在运行时可再次等待或查询，不会取消任务。",
            "inputSchema": {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}, "timeout": {"type": "integer", "minimum": 1, "maximum": 30}}},
        },
        {
            "name": "get_job_artifacts",
            "description": "获取任务的全部媒体产物和下载 URL。",
            "inputSchema": {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}},
        },
        {
            "name": "read_job_artifact",
            "description": "分块读取任务产物并返回 Base64；局域网或远程客户端重复调用直到 eof=true 后按 offset 拼接。",
            "inputSchema": {
                "type": "object",
                "required": ["job_id"],
                "properties": {
                    "job_id": {"type": "string", "minLength": 1},
                    "artifact_index": {"type": "integer", "minimum": 0, "default": 0},
                    "offset": {"type": "integer", "minimum": 0, "default": 0},
                    "length": {"type": "integer", "minimum": 1, "maximum": MAX_ARTIFACT_CHUNK_BYTES,
                               "default": MAX_ARTIFACT_CHUNK_BYTES},
                },
            },
        },
        {
            "name": "get_job_inputs",
            "description": "只读查询实际保存的任务参考素材、upload_id和SHA256，用于验证生成确实使用了参考。",
            "inputSchema": {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}},
        },
        {
            "name": "cancel_job",
            "description": "取消仍在排队或运行中的任务。",
            "inputSchema": {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}},
        },
    ]
    submission = next(tool for tool in tools if tool["name"] == "submit_generation")
    tools.append({
        "name": "list_project_categories",
        "description": "只读查询项目分类；生成时可传 category_id，省略则归默认分类。",
        "inputSchema": {"type": "object", "required": ["project_id"], "properties": {"project_id": {"type": "string"}}},
    })
    tools.append({
        "name": "list_public_assets",
        "description": "只读查询项目公共资产档案：人物角色板、场景、道具、配乐、音效；包含名称、文字设定和可下载引用的媒体URL。按需选择参考，不要把全部文件提交。",
        "inputSchema": {"type": "object", "required": ["project_id"], "properties": {"project_id": {"type": "string"}}},
    })
    submission["description"] = "统一插件生成入口：先 list_capabilities 查询 processing_modes 和 parameters，按注册的模式 ID 提交；direct 直接生成，其余模式由插件处理。追问用 session_id 和 answer 回答，不自动确认。"
    submission["inputSchema"] = CreateRequest.model_json_schema()
    submission["inputSchema"]["properties"].update({"idempotency_key": {"type": "string"}})
    regenerate_schema = RegenerateRequest.model_json_schema()
    regenerate_schema["properties"].update({"job_id": {"type": "string"}})
    regenerate_schema["required"] = ["job_id"]
    tools.append({"name": "regenerate_job", "description": "重新生成任务，保留原始任务；修改双语稿时必须同时传入中英文。", "inputSchema": regenerate_schema})
    for name, description in (
        ("get_health", "查询网关与生成服务状态。"),
        ("list_voices", "只读查询预设音色与 ready 状态，不允许修改预设。"),
        ("list_image_styles", "只读查询图片风格。"),
        ("list_music_styles", "只读查询音乐风格。"),
        ("list_music_singers", "只读查询歌手预设。"),
        ("list_music_voice_textures", "只读查询音乐音色。"),
    ):
        tools.append({"name": name, "description": description, "inputSchema": {"type": "object", "properties": {}}})
    tools.extend([
        {"name": "list_plugin_actions", "description": "发现插件允许 AI 调用的动作及其输入 Schema。可按动作范围或源任务过滤。", "inputSchema": {"type": "object", "properties": {"scope": {"type": "string", "enum": ["resource", "workspace", "automation"]}, "source_job_id": {"type": "string"}, "source_kind": {"type": "string", "enum": ["image", "video", "tts", "music", "audio"]}, "include_unavailable": {"type": "boolean"}}}},
        {"name": "get_plugin_action", "description": "读取一个插件动作的完整声明和输入 Schema。", "inputSchema": {"type": "object", "required": ["action_id"], "properties": {"action_id": {"type": "string"}}}},
        {"name": "run_plugin_action", "description": "执行插件声明且允许自动化调用的动作；先通过 list_plugin_actions 获取 action_id 和 inputs。", "inputSchema": {"type": "object", "required": ["action_id"], "properties": {"action_id": {"type": "string"}, "source_job_id": {"type": "string"}, "source_upload_id": {"type": "string", "pattern": "^[a-fA-F0-9]{32}$"}, "project_id": {"type": "string"}, "category_id": {"type": "string"}, "inputs": {"type": "object"}}}},
    ])
    string = {"type": "string"}
    page = {"limit": {"type": "integer", "minimum": 1, "maximum": 100}, "offset": {"type": "integer", "minimum": 0}}
    for name, description, required, properties in (
        ("list_jobs", "查询生成任务，支持项目、状态、类型及分页。", [], {**page, "project_id": string, "status": string, "kind": string}),
        ("list_library", "查询本地项目素材库，支持分类、类型及分页。", [], {**page, "project_id": string, "category_id": string, "kind": string, "sort": {"type": "string", "enum": ["new", "old"]}}),
        ("list_collaborations", "查询项目全部协作会话；active=true 时仅返回进行中的会话。", ["project_id"], {"project_id": string, "active": {"type": "boolean"}}),
        ("cancel_collaboration", "取消排队、运行或等待输入的协作。", ["collaboration_id"], {"collaboration_id": string}),
        ("create_project_category", "创建项目分类。", ["project_id", "name"], {"project_id": string, "name": string}),
        ("update_project_category", "修改项目分类名称。", ["project_id", "category_id", "name"], {"project_id": string, "category_id": string, "name": string}),
        ("create_public_asset", "创建公共资产档案。", ["project_id", "name", "kind"], {"project_id": string, "name": string, "kind": string, "description": string, "voice_text": string}),
        ("update_public_asset", "修改公共资产档案。", ["project_id", "asset_id", "name", "kind"], {"project_id": string, "asset_id": string, "name": string, "kind": string, "description": string, "voice_text": string}),
        ("attach_public_asset_media", "为项目资产绑定素材。source 使用 get_job_artifacts/list_library 返回的当前项目 project_path，或 upload_reference 返回的 upload:<upload_id>；不能直接传 job_id。", ["project_id", "asset_id", "source"], {"project_id": string, "asset_id": string, "source": string, "role": string, "transcript": string}),
        ("update_project", "修改项目名称、简介与内容摘要；未传入的简介与摘要保留原值，传空字符串则清空。", ["project_id", "name"], {"project_id": string, "name": string, "description": string, "content_summary": string}),
        ("list_plugins", "查询插件清单、注册状态及错误。", [], {}),
        ("list_plugin_presets", "查询插件声明的预设选项及音色，无需插件专用工具。", ["plugin_id"], {"plugin_id": string}),
    ):
        tools.append({"name": name, "description": description, "inputSchema": {
            "type": "object", "required": required, "properties": properties}})
    return tools


async def _tool_result(name: str, arguments: dict[str, Any], *, allow_local_file_path: bool = False) -> dict[str, Any]:
    if name in {"list_jobs", "list_library", "list_collaborations"}:
        fields = {"list_jobs": ("project_id", "kind", "status", "limit", "offset"),
                  "list_library": ("project_id", "kind", "category_id", "limit", "offset", "sort"),
                  "list_collaborations": ("project_id", "active")}[name]
        query = urllib.parse.urlencode({key: str(arguments[key]).lower() if isinstance(arguments[key], bool) else arguments[key]
                                       for key in fields if arguments.get(key) is not None})
        path = {"list_jobs": "jobs", "list_library": "library", "list_collaborations": "collaborations"}[name]
        return _text(await _local_api("GET", f"/api/v2/{path}?{query}"))
    if name == "list_plugins":
        return _text(await _local_api("GET", "/api/v2/plugins"))
    if name == "list_plugin_presets":
        plugin_id = urllib.parse.quote(str(arguments["plugin_id"]), safe="")
        return _text(await _local_api("GET", f"/api/v2/plugins/{plugin_id}/presets"))
    if name == "cancel_collaboration":
        identifier = urllib.parse.quote(str(arguments["collaboration_id"]), safe="")
        return _text(await _local_api("POST", f"/api/v2/collaborations/{identifier}/cancel"))
    writes = {
        "create_project_category": ("POST", "/v1/projects/{project_id}/categories", ("name",)),
        "update_project_category": ("PUT", "/v1/projects/{project_id}/categories/{category_id}", ("name",)),
        "create_public_asset": ("POST", "/v1/projects/{project_id}/public-assets", ("name", "kind", "description", "voice_text")),
        "update_public_asset": ("PUT", "/v1/projects/{project_id}/public-assets/{asset_id}", ("name", "kind", "description", "voice_text")),
        "attach_public_asset_media": ("POST", "/v1/projects/{project_id}/public-assets/{asset_id}/media", ("source", "role", "transcript")),
        "update_project": ("PUT", "/v1/projects/{project_id}", ("name", "description", "content_summary")),
    }
    if name in writes:
        method, template, fields = writes[name]
        path = template.format(**{key: urllib.parse.quote(str(arguments[key]), safe="")
                                  for key in ("project_id", "category_id", "asset_id") if key in arguments})
        payload = {key: arguments[key] for key in fields if key in arguments}
        return _text(await _local_api(method, path, payload))
    if name == "list_public_assets":
        project_id = urllib.parse.quote(str(arguments["project_id"]), safe="")
        return _text(await _local_api("GET", f"/v1/projects/{project_id}/public-assets"))
    if name == "list_project_categories":
        project_id = urllib.parse.quote(str(arguments["project_id"]), safe="")
        return _text(await _local_api("GET", f"/api/v2/projects/{project_id}/categories"))
    read_paths = {"get_health": "/health", "list_voices": "/voices", "list_image_styles": "/image/styles", "list_music_styles": "/music/styles", "list_music_singers": "/music/singers", "list_music_voice_textures": "/music/voice-textures"}
    if name in read_paths:
        return _text(await _local_api("GET", "/api/v2" + read_paths[name]))
    if name == "regenerate_job":
        payload = RegenerateRequest.model_validate(arguments).model_dump(mode="json", exclude_unset=True)
        return _text(await _local_api("POST", f"/api/v2/jobs/{arguments['job_id']}/regenerate", payload))
    if name == "list_plugin_actions":
        query = urllib.parse.urlencode({
            "scope": str(arguments.get("scope") or ""),
            "source_job_id": str(arguments.get("source_job_id") or ""),
            "source_kind": str(arguments.get("source_kind") or ""),
            "include_unavailable": str(bool(arguments.get("include_unavailable", False))).lower(),
            "automation": "true",
        })
        return _text(await _local_api("GET", f"/api/v2/plugin-actions?{query}"))
    if name == "get_plugin_action":
        action_id = urllib.parse.quote(str(arguments["action_id"]), safe="")
        action = await _local_api("GET", f"/api/v2/plugin-actions/{action_id}")
        if not action.get("automation", False):
            raise ValueError("该插件动作不允许 AI 调用")
        return _text(action)
    if name == "run_plugin_action":
        action_id = urllib.parse.quote(str(arguments["action_id"]), safe="")
        action = await _local_api("GET", f"/api/v2/plugin-actions/{action_id}")
        if not action.get("automation", False):
            raise ValueError("该插件动作不允许 AI 调用")
        payload = {
            "source_job_id": arguments.get("source_job_id"),
            "project_id": arguments.get("project_id"),
            "inputs": arguments.get("inputs") or {},
        }
        for key in ("source_upload_id", "category_id"):
            if key in arguments:
                payload[key] = arguments[key]
        return _text(await _local_api("POST", f"/api/v2/plugin-actions/{action_id}/execute", payload))
    if name == "list_projects":
        return _text(await _local_api("GET", "/api/v2/projects"))
    if name == "create_project":
        payload = {"name": str(arguments.get("name", "")), "description": str(arguments.get("description", "")), "content_summary": str(arguments.get("content_summary", "")), "ai_created": True}
        return _text(await _local_api("POST", "/api/v2/projects", payload))
    if name == "get_current_project":
        return _text(await _local_api("GET", "/api/v2/projects/current"))
    if name == "set_current_project":
        return _text(await _local_api("PUT", "/api/v2/projects/current", {"project_id": str(arguments.get("project_id", ""))}))
    if name == "list_capabilities":
        return _text(_capabilities(arguments.get("kind"), arguments.get("category")))
    if name == "get_capability":
        capability_id = str(arguments.get("capability_id", ""))
        config = _registry().get(capability_id)
        if not config:
            raise ValueError(f"能力不存在: {capability_id}")
        return _text(public_capability(capability_id, config))
    if name == "get_collaboration" or name == "get_final_prompt":
        if name == "get_collaboration":
            value = await _local_api("GET", f"/api/v2/collaborations/{arguments.get('collaboration_id', '')}")
            # Retain result/progress for existing MCP consumers; canonical fields come from HTTP.
            item = context.db.collaboration(str(arguments.get("collaboration_id", "")))
            if item:
                value.update(result=item.get("result", {}), progress=item.get("progress", {}))
            return _text(value)
        item = context.db.collaboration(str(arguments.get("collaboration_id", "")))
        if not item:
            raise ValueError("协作任务不存在")
        # The HTTP route is the canonical project authorization boundary.
        value = await _local_api("GET", f"/api/v2/collaborations/{item['id']}")
        item = {**item, **value}
        result = item.get("result", {}) if isinstance(item.get("result"), dict) else {}
        if name == "get_final_prompt":
            return _text({"id": item["id"], "status": item["status"], "revision": item.get("revision", 0), "execution_prompt_en": result.get("optimized_prompt", ""), "confirmed_prompt_zh": result.get("optimized_prompt_zh", ""), "review": result.get("review", {})})
        return _text({"id": item["id"], "status": item["status"], "result": result, "progress": item.get("progress", {}), "revision": item.get("revision", 0)})
    if name == "create_director_collaboration":
        capability_id = str(arguments.get("capability_id", ""))
        capability_config = _registry().get(capability_id)
        if not capability_config:
            raise ValueError(f"能力不存在: {capability_id}")
        capability_view = public_capability(capability_id, capability_config)
        if not capability_view.get("collaboration_supported"):
            raise ValueError(f"能力不支持导演协作: {capability_id}")
        model_id = str(arguments.get("model_id") or capability_view["model"])
        mode_id = str(arguments.get("mode_id") or capability_view["mode"])
        return _text(await _local_api("POST", "/api/v2/collaborations", {
            "capability_id": capability_id,
            "model_id": model_id,
            "mode_id": mode_id,
            "message": str(arguments.get("message", "")),
            "collaboration_mode": str(arguments.get("collaboration_mode", "director")),
            "inputs": arguments.get("inputs") or [],
            "settings": arguments.get("settings") or {},
            "project_id": arguments.get("project_id"),
            "category_id": arguments.get("category_id"),
        }))
    if name == "send_collaboration_message":
        collaboration_id = str(arguments.get("collaboration_id", ""))
        return _text(await _local_api(
            "POST", f"/api/v2/collaborations/{collaboration_id}/messages",
            {"message": str(arguments.get("message", ""))},
        ))
    if name == "upload_reference":
        has_base64 = isinstance(arguments.get("data_base64"), str) and bool(arguments["data_base64"])
        has_path = isinstance(arguments.get("file_path"), str) and bool(arguments["file_path"].strip())
        if has_base64 == has_path:
            raise ValueError("upload_reference requires exactly one of data_base64 or file_path")
        source = None
        if has_path:
            if not allow_local_file_path:
                raise ValueError("file_path 仅允许通过网关本机 127.0.0.1 或 ::1 的 MCP 连接使用")
            source = Path(arguments["file_path"]).expanduser().resolve()
            if not source.is_file():
                raise ValueError("file_path must reference an existing regular file")
            if source.stat().st_size > context.config.max_upload_bytes:
                raise ValueError(f"file exceeds upload limit ({context.config.max_upload_bytes} bytes)")
        default_name = source.name if source is not None else "reference.bin"
        filename = str(arguments.get("filename") or default_name).replace("\\", "/").rsplit("/", 1)[-1]
        if not filename or any(char in filename for char in '\r\n"'):
            raise ValueError("filename contains invalid characters")
        media_type = str(arguments.get("media_type") or mimetypes.guess_type(filename)[0] or "application/octet-stream")
        if source is not None:
            raw = source.read_bytes()
        else:
            encoded = arguments["data_base64"].strip()
            if not encoded:
                raise ValueError("data_base64 不能为空")
            if len(encoded) > ((context.config.max_upload_bytes + 2) // 3) * 4:
                raise ValueError(f"file exceeds upload limit ({context.config.max_upload_bytes} bytes)")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("data_base64 必须是不带 data: 前缀的有效 Base64") from exc
            if len(raw) > context.config.max_upload_bytes:
                raise ValueError(f"file exceeds upload limit ({context.config.max_upload_bytes} bytes)")
        boundary = f"----VideoFreeMCP{uuid.uuid4().hex}"
        head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {media_type}\r\n\r\n").encode()
        body = head + raw + f"\r\n--{boundary}--\r\n".encode()
        return _text(await asyncio.to_thread(_local_api_request, "POST", "/v1/uploads", body, f"multipart/form-data; boundary={boundary}"))
    if name == "submit_generation":
        # Preserve omission so capability-specific defaults remain owned by the plugin.
        payload = CreateRequest.model_validate(arguments).model_dump(mode="json", exclude_unset=True)
        result = await asyncio.to_thread(_local_api_request, "POST", "/api/v2/generations", json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json", str(arguments.get("idempotency_key", "")))
        return _text(result)
    if name == "confirm_collaboration":
        payload = {"revision": int(arguments.get("revision", 0))}
        if arguments.get("idempotency_key"):
            payload["idempotency_key"] = str(arguments["idempotency_key"])
        if arguments.get("execution_prompt_en") is not None:
            payload["execution_prompt_en"] = str(arguments["execution_prompt_en"])
        if arguments.get("confirmed_prompt_zh") is not None:
            payload["confirmed_prompt_zh"] = str(arguments["confirmed_prompt_zh"])
        result = await asyncio.to_thread(_local_api_request, "POST", f"/api/v2/collaborations/{arguments.get('collaboration_id', '')}/confirm", json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json", str(arguments.get("idempotency_key", "")))
        return _text(result)
    if name == "get_job":
        return _text(await _local_api("GET", f"/api/v2/jobs/{arguments.get('job_id', '')}"))
    if name == "wait_job":
        # Keep a single MCP call below common clients' 60-second request limit.
        timeout = max(1, min(30, int(arguments.get("timeout", 30))))
        return _text(await _local_api("GET", f"/api/v2/jobs/{arguments.get('job_id', '')}/wait?timeout={timeout}"))
    if name == "get_job_artifacts":
        result = await _local_api("GET", f"/api/v2/jobs/{arguments.get('job_id', '')}/artifacts")
        if allow_local_file_path:
            artifact_root = context.paths.artifacts.resolve()
            for item in result.get("items", []) if isinstance(result, dict) else []:
                if not isinstance(item, dict):
                    continue
                candidate = (artifact_root / str(item.get("name", ""))).resolve()
                if candidate.is_relative_to(artifact_root) and candidate.is_file():
                    item["local_path"] = str(candidate)
        return _text(result)
    if name == "read_job_artifact":
        result = await _local_api("GET", f"/api/v2/jobs/{arguments.get('job_id', '')}/artifacts")
        items = result.get("items", []) if isinstance(result, dict) else []
        index = int(arguments.get("artifact_index", 0))
        if index < 0 or index >= len(items) or not isinstance(items[index], dict):
            raise ValueError("artifact_index 超出任务产物范围")
        offset = int(arguments.get("offset", 0))
        length = int(arguments.get("length", MAX_ARTIFACT_CHUNK_BYTES))
        if offset < 0 or not 1 <= length <= MAX_ARTIFACT_CHUNK_BYTES:
            raise ValueError(f"offset 必须不小于 0，length 必须在 1-{MAX_ARTIFACT_CHUNK_BYTES} 之间")
        item = items[index]
        artifact_root = context.paths.artifacts.resolve()
        candidate = (artifact_root / str(item.get("name", ""))).resolve()
        if not candidate.is_relative_to(artifact_root) or not candidate.is_file():
            raise ValueError("任务产物文件不存在或路径无效")
        size = candidate.stat().st_size
        if offset > size:
            raise ValueError("offset 超出任务产物大小")
        with candidate.open("rb") as handle:
            handle.seek(offset)
            chunk = handle.read(length)
        next_offset = offset + len(chunk)
        eof = next_offset >= size
        return _text({
            "job_id": str(arguments.get("job_id", "")),
            "artifact_index": index,
            "name": candidate.name,
            "media_type": item.get("media_type") or mimetypes.guess_type(candidate.name)[0] or "application/octet-stream",
            "size": size,
            "offset": offset,
            "bytes_read": len(chunk),
            "data_base64": base64.b64encode(chunk).decode("ascii"),
            "next_offset": None if eof else next_offset,
            "eof": eof,
        })
    if name == "get_job_inputs":
        return _text(await _local_api("GET", f"/api/v2/jobs/{arguments.get('job_id', '')}/inputs"))
    if name == "cancel_job":
        return _text(await _local_api("POST", f"/api/v2/jobs/{arguments.get('job_id', '')}/cancel"))
    raise ValueError(f"工具尚未实现: {name}")


def build_router() -> APIRouter:
    router = APIRouter(prefix="/mcp", tags=["MCP"], dependencies=[Depends(auth)])

    @router.post("")
    async def mcp_endpoint(request: Request):
        try:
            payload = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            return JSONResponse(
                _jsonrpc(None, error={
                    "code": -32700,
                    "message": "Parse error: 请求体不是合法 JSON，请使用双引号和标准 JSON 格式",
                    "data": str(exc),
                }),
                status_code=400,
            )
        if not isinstance(payload, dict):
            return JSONResponse(
                _jsonrpc(None, error={
                    "code": -32600,
                    "message": "Invalid Request: MCP 请求体必须是 JSON 对象",
                }),
                status_code=400,
            )
        request_id = payload.get("id")
        method = payload.get("method")
        if not isinstance(method, str) or not method.strip():
            return JSONResponse(
                _jsonrpc(request_id, error={
                    "code": -32600,
                    "message": "Invalid Request: 缺少有效的 method",
                }),
                status_code=400,
            )
        params = payload.get("params") or {}
        if method == "initialize":
            return JSONResponse(_jsonrpc(request_id, {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": MCP_SERVER_INFO}))
        if method == "notifications/initialized":
            return JSONResponse({}, status_code=202)
        if method == "tools/list":
            return JSONResponse(_jsonrpc(request_id, {"tools": _tool_definitions()}))
        if method == "tools/call":
            try:
                client_host = request.client.host if request.client else ""
                try:
                    client_ip = ipaddress.ip_address(client_host)
                    allow_local_file_path = client_ip.is_loopback or bool(
                        client_ip.version == 6 and client_ip.ipv4_mapped and client_ip.ipv4_mapped.is_loopback
                    )
                except ValueError:
                    allow_local_file_path = False
                return JSONResponse(_jsonrpc(request_id, await _tool_result(
                    str(params.get("name", "")), params.get("arguments") or {},
                    allow_local_file_path=allow_local_file_path,
                )))
            except Exception as exc:
                return JSONResponse(_jsonrpc(request_id, error={"code": -32000, "message": str(exc)}))
        return JSONResponse(_jsonrpc(request_id, error={"code": -32601, "message": f"Method not found: {method}"}))

    @router.get("")
    async def mcp_info():
        return {"name": MCP_SERVER_INFO["name"], "protocol": "MCP Streamable HTTP", "endpoint": "/mcp", "server_info": MCP_SERVER_INFO}

    return router
