# Copyright (c) 2026 VideoFree Studio individual project author and contributors.
# Part of VideoFree Studio: https://github.com/linpengishero/VideoFreeStudio
# Licensed under the GNU Affero General Public License v3.0; see LICENSE and NOTICE.
# Separate commercial licensing may be available; see COMMERCIAL_LICENSE.md.

"""Generic system-service bridge to the configured typed ComfyUI provider."""


class Provider:
    def __init__(self, manifest):
        self.manifest = manifest

    def invoke(self, operation, inputs, settings, *, context):
        if operation != "system_stats" or inputs:
            raise ValueError("Unsupported ComfyUI system operation")
        provider = getattr(context, "comfyui_provider", None)
        if provider is None:
            raise RuntimeError("ComfyUI provider is unavailable")
        return provider.system_stats()
