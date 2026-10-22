# 协议与实现参考

审阅日期：**2026-10-22（UTC）**。以下记录来源与证据范围，避免把社区兼容实现、官方工作流和真实账户测试混为一谈。本文只概述协议事实，不转载整篇官方文档。

## 官方个人账号资料

仓库：[kdocs-app/kdocs-skill](https://github.com/kdocs-app/kdocs-skill)，审阅版本 **2.7.1**；记录的 commit 为 [`1c5bf7574aed4e813ba2ab01321287b47c5e772b`](https://github.com/kdocs-app/kdocs-skill/commit/1c5bf7574aed4e813ba2ab01321287b47c5e772b)，commit 时间 `2026-10-10T03:02:46Z`。`auth.md` 与 `drive/create_and_upload.md` 已用固定 commit 再次下载，确认与此前审阅副本字节一致。

| 参考文件 | 用于核对 |
| --- | --- |
| [SKILL.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/SKILL.md) | 官方个人账号 Skill / CLI 主入口与工作流 |
| [references/auth.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/auth.md) | 个人账号范围、授权取消、企业账号错误、手动 Token 入口 |
| [references/drive.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive.md) | `list_my_files`、文件定位、文件工具索引、通用返回 |
| [drive/search.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive/search.md) | `search_files` 与分页 |
| [drive/read_and_download.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive/read_and_download.md) | `read_file`、`get_file_info`、pending 与内容读取限制 |
| [drive/create_and_upload.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive/create_and_upload.md) | `create_file_with_content`、`upload_replace_file`；创建表格的二维 `formula` |
| [drive/share.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive/share.md) | `get_file_link` 与单独的 `share_file` 行为描述 |
| [sheet/worksheet.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/sheet/worksheet.md) | `sheet.get_sheets_info` 与真实工作表 ID |
| [sheet/data.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/sheet/data.md) | `sheet.get_range_data`、`sheet.range_data_batch_update`、`sheet.update_range_data` |
| [wps/texts.content.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/wps/texts.content.md) | `wps.texts.content` 的 scope / verb |
| [wps/texts.replace.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/wps/texts.replace.md) | `wps.texts.replace` 的模式区分 |
| [wps/texts-replace/paragraphs_replace.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/wps/texts-replace/paragraphs_replace.md) | 段落精确替换与跳过多处匹配 |
| [wps/texts.search.md](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/wps/texts.search.md) | `wps.texts.search` 与内容位置 |

官方授权页面：[auth-guide](https://mcp-center.wps.cn/kdocs-auth/auth-guide)。审阅其公开 HTML 及引用的 `auth-guide-eafDsXX1.js`、`state-BjPnxwAO.js`、`app-chat-qwgGBTIy.js`，核对官方登录回调、UUID 处理和取消请求；未执行这些脚本完成登录。静态资源名称可能随官方发布变更。

## 实时 MCP 元数据

官方端点：[SkillHub MCP](https://mcp-center.wps.cn/skill_hub/mcp)。于上述日期匿名执行 `initialize`、`notifications/initialized`、`tools/list`：状态分别为 200 / 202 / 200；服务自报 `SkillHub MCP` 版本 `1.0.0`；返回 619 个工具且无 `nextCursor`。

全部 619 项工具的参数名、类型和顶层 `required` 来自本次真实 `tools/list`，不是从 CLI 命令名称推测。具体列表与比 schema 更严格的工作流约束见 [PROTOCOL.md](./PROTOCOL.md)。619 个工具均有相同 annotations，不能据此自动判断某个操作是否安全。0.2 将完整快照和来源元数据保存在 `lib/catalog/`，经分类入口调用；用法与更多来源见 [USAGE.md](./USAGE.md)。

这次检查不携带账户凭据，也没有执行业务 `tools/call`。原始 metadata 是研发核实记录，不是“619 项功能全部可用”的验收证据。

## 社区协议参考及许可

参考仓库：[zhengjy01/dsh-wps](https://github.com/zhengjy01/dsh-wps)，固定 commit [`c59a2f869c336364c8d109194a8a83fc6b55d56c`](https://github.com/zhengjy01/dsh-wps/commit/c59a2f869c336364c8d109194a8a83fc6b55d56c)，时间 `2026-09-29T15:34:54Z`。

- [`src/auth.ts`](https://github.com/zhengjy01/dsh-wps/blob/c59a2f869c336364c8d109194a8a83fc6b55d56c/src/auth.ts)：UUID 授权码、官方引导页、exchange 请求、响应兼容与轮询。
- [`src/mcp.ts`](https://github.com/zhengjy01/dsh-wps/blob/c59a2f869c336364c8d109194a8a83fc6b55d56c/src/mcp.ts)：HTTP MCP 初始化、session header、分页与原名工具调用。
- [`LICENSE`](https://github.com/zhengjy01/dsh-wps/blob/c59a2f869c336364c8d109194a8a83fc6b55d56c/LICENSE)：**MIT**，`Copyright (c) 2026 zhengjy01`。

本项目以公开协议事实为参考独立实现服务端授权、凭据隔离和工具网关，没有直接复制该仓库的实现源码。MIT 仅说明上述参考仓库许可，不代表 WPS 官方服务、文档或接口另有相同许可，也不构成 WPS 对本项目的背书。未安装或运行该社区程序。

## 企业与在线编辑资料（仅用于划清边界）

- [WPS365 MCP 介绍](https://open.wps.cn/documents/app-integration-dev/mcp-server/introduction)
- [WPS365 MCP 使用指南](https://open.wps.cn/documents/app-integration-dev/mcp-server/use-guide)
- [WPS365 云文档 MCP 工具](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-yundoc)
- [WPS365 服务端产品介绍](https://open.wps.cn/documents/app-integration-dev/wps365/server/introduce)
- [WPS365 CLI](https://github.com/wps365-open/cli)
- [WebOffice 集成原理](https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/principle)

这些资料不用于推断个人账号 token 的有效期、刷新方式、授权范围或费用。个人账号实测、上游服务可用性和具体客户端兼容性仍需单独验收。

## Cloudflare 运行时依据

[workerd HTTP 实现](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B) 中 Request 构造只支持 redirect 的 follow/manual，明确不实现 error。2026-10-22 在本项目安装的 workerd 1.20260515.1 本地验证：error 抛 TypeError，manual + no-store + omit 可构造；生产协议连通性用无个人数据的 health 探测另验。

## 0.3 代码生成 PPTX

- [PptxGenJS 官方仓库](https://github.com/gitbrent/PptxGenJS)：项目固定使用 4.0.1，原生文本、宽屏布局及 Base64 输出。
- [PptxGenJS 保存方式](https://gitbrent.github.io/PptxGenJS/docs/usage-saving/)：内存输出，不依赖桌面 PowerPoint 或 WPS。
- [JSZip 官方仓库](https://github.com/Stuk/jszip)：固定 3.10.1，用于检查并重新打包自生成的 OOXML 包。
- 个人 WPS 上传和演示回读的字段仍以本页所列固定版本 `drive/create_and_upload.md`、`drive/read_and_download.md` 为准，不能将桌面对象模型或另一种 WebOffice SDK 的排版参数直接套到个人 MCP。

本次对生成文件做了独立 ZIP/XML 结构检查及中文边界样例渲染。PptxGenJS 4.0.1 多页输出中不存在的额外母版声明是本地实际输出观察；项目只清理自身生成文件的这些声明，不修改依赖源码或外来用户文件。真实 WPS 打开效果仍属于账号验收范围。
