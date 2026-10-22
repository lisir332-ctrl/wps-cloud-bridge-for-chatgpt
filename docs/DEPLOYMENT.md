# 部署与公开发布边界

## 本地开发

安装 Node.js 22.13+、pnpm 11.25.0，运行 `pnpm install --frozen-lockfile`、`pnpm dev`。构建使用 `pnpm build`；回归使用 `node tests/run.mjs`。本地开发可验证目录与页面，但**没有可信身份和 D1 配置时，不能读取或写入真实 WPS 账号**。

`drizzle/` 保存数据库迁移。托管时绑定 D1 为 `DB`，将 32 字节随机密钥的 64 位十六进制值作为 `WPS_ENCRYPTION_KEY` secret，并设置站点的 HTTPS `SITE_ORIGIN`。加密密钥须备份且不进入 Git；更换密钥会使已保存的连接令牌无法解密。数据库备份也应受访问控制，不放进公开仓库。

## 当前托管模型

当前实现面向受控的 Codex Sites 环境：平台在用户登录后注入可信的 `oai-authenticated-user-id`。服务端不接受请求正文中的用户 ID。`/mcp` 的工具发现可以匿名完成，但真实账号工具调用必须识别用户并取得该用户的 WPS 授权。连接页的更改操作还要求同源请求。

若使用其他托管商，需要实现并核验新的认证适配器。**不能**简单地让互联网客户端提交同名 Header；任何普通用户若可自填它，就可能冒用别人的连接。正式公开前还应验证：匿名请求无法读取账号；两个已登录用户的数据完全隔离；断开连接即时生效；上游错误或授权码不会泄漏到日志或链接。

仓库的 `.openai/hosting.json` 包含原站点项目 ID，仅用于原站点构建。公开源码分发时必须将其中的 `project_id` 换为零值占位符；Sites 构建插件仍需该文件存在。真正部署前换成自己创建的项目 ID。原站点的访问策略与秘密值从不属于开源代码。

## ChatGPT 公开目录

本项目的产品类型是 **submission-ready 的 tool-only MCP 插件**；连接页是站外授权页面，ChatGPT 内不需要第二个工作台。公开上架前，除了源码和可用的 HTTPS `/mcp`，还需：

- 可公开连接的稳定域名和可完成审核的用户身份认证。当前私有 Sites 身份头**不等同**于公开 MCP 的 OAuth 2.1 机制；不能在插件清单里把受保护服务器标成无认证。
- 开发者或企业身份核验、插件提交权限、域名验证，以及可供审核的测试账号和演示视频。
- 清晰、可访问的支持、隐私和服务条款 URL；准确的图标、说明、5 个正例及 3 个反例测试用例。
- 审核通过后由发布者在提交门户手动发布；GitHub 仓库链接可以放在 `repository` 字段和产品网站，但星标数量与目录展示不由连接器控制。

OpenAI 当前插件指南还明确不批准以**未经授权的第三方服务连接器**为主要功能的插件。本项目要进入公共目录，必须先取得 WPS 对此集成和分发的认可或其他可验证的授权依据；不能仅因个人账号授权成功就宣称得到 WPS 对公共插件的批准。

参阅 [OpenAI 插件提交说明](https://developers.openai.com/plugins/deploy/submission)、[远程 MCP 审核要求](https://developers.openai.com/plugins/deploy/app-review)、[认证规范](https://developers.openai.com/plugins/build/auth)。本仓库未完成这些外部账号与公开认证步骤时，不应声称已经在 ChatGPT 目录上架。
