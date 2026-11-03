# Infinite Canvas workflow examples

These JSON files are distributable examples shipped with the Infinite Canvas
plugin. Copy one, edit it, or drop the single JSON file onto the canvas to
load it as a new workflow. The current workflow is never overwritten.

这些 JSON 是随无限画布插件分发的可复制示例。可以复制、编辑，也可以把单个
JSON 文件直接拖到画布中加载；导入会创建新的工作流，不会覆盖当前工作流。

## Import rules / 导入规则

- Drop one `.json` file at a time. Do not mix a workflow JSON with media files.
- The file must have `schema_version: 1`, `kind: videofree.infinite-canvas`,
  valid node IDs/types, and valid edge references.
- Unknown plugin nodes can be viewed after import, but validation and execution
  will stop until the required plugin is installed.
- Examples use stable built-in input, condition, and preview nodes. The
  condition example requires a configured system LLM and may consume tokens.
- Exported workflows can contain custom API keys. Remove secrets before sharing.

- 每次只拖入一个 `.json` 文件，不能和图片、视频或音频混拖。
- 文件必须包含 `schema_version: 1`、`kind: videofree.infinite-canvas`，并通过节点
  ID、类型和连线引用校验。
- 缺少插件节点的工作流可以查看，但安装对应插件前不能通过检查或运行。
- 示例使用稳定的内置输入、条件和预览节点；条件示例需要已配置系统 LLM，可能消耗
  token。
- 导出的工作流可能包含自定义 API Key，公开分享前必须清除密钥。

The files in this directory are source examples. User-created workflows are
saved separately under the current project's runtime plugin data directory,
not in this directory.

本目录只保存插件源码中的示例。用户创建的工作流仍保存到当前项目的运行时插件
数据目录，不会写回本目录。
