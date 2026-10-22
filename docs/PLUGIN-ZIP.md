# Plugin ZIP vs. source ZIP / 插件 ZIP 与源码 ZIP

## English

The [v0.9.0-preview.1 plugin ZIP](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/releases/tag/v0.9.0-preview.1) contains `plugin.json` and `mcp.json` at its root and points to a [separate public cloud endpoint](https://wps-cloud-bridge-public.team17843977-2024.chatgpt.site/). The original owner's private Site, database, and WPS connection are separate. The [v0.8.1 source ZIP](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/releases/tag/v0.8.1) is source code and cannot be uploaded as a plugin.

**Preview installation:** Download `WPS-Cloud-Bridge-plugin-preview-v0.9.0.zip` from the preview Release. In ChatGPT Plugins, use the **With MCP** ZIP upload path. If accepted, connect to the hosted service, sign in with your own ChatGPT account, and authorize your own WPS account on its page. The server selects encrypted WPS credentials by the identity supplied by ChatGPT and rejects missing identity. The ZIP carries neither credentials nor a copy of the owner's WPS account.

**Verification status:** the new cloud Site is deployed, its MCP OAuth protected-resource metadata responds, and unauthenticated requests are refused. A second user's end-to-end connection, the actual ChatGPT ZIP upload, and WPS read/write under that second account have **not yet been verified**. Treat the ZIP as an experimental personal-install preview, not as guaranteed one-click installation. Report upload or authorization errors in [GitHub Issues](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/issues).

**Public Plugin Directory:** this package has not been submitted or approved. OpenAI's public guidelines require authorization for third-party service integrations and disallow generic discovery/schema-fetching followed by a generic executor. The current 619-tool catalog uses such an executor, so the public tool surface must be redesigned. WPS distribution rights, developer verification, policy pages, review account, and successful review are also open. A ZIP only registers configuration; the cloud server performs document operations.

## 简体中文

[v0.9.0-preview.1 插件 ZIP](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/releases/tag/v0.9.0-preview.1) 的根目录包含 `plugin.json` 和 `mcp.json`，指向[独立的公开云端入口](https://wps-cloud-bridge-public.team17843977-2024.chatgpt.site/)。原站点的私人数据库、加密密钥和 WPS 授权均未迁入。[v0.8.1 源码 ZIP](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/releases/tag/v0.8.1) 仅用于阅读或自行托管，不能当插件包上传。

**预览安装：**从预览 Release 下载 `WPS-Cloud-Bridge-plugin-preview-v0.9.0.zip`，在 ChatGPT Plugins 中选择 **With MCP** 上传。若平台接受，再用自己的 ChatGPT 账户连接云端服务，并在授权页授权自己的 WPS 账户。服务按 ChatGPT 提供的用户 ID 读取分别加密保存的 WPS 凭据；没有身份的请求会被拒绝。ZIP 不含任何人的 WPS 令牌。

**当前验证范围：**新站点已部署，MCP 的 OAuth 资源元数据可访问，未登录请求会被拒绝。**第二个 ChatGPT 账号的完整连接、ZIP 的实际上传、以及该账号的 WPS 读写尚未完成实测。**因此这是个人安装预览包，不承诺“下载即成功”。遇到上传或授权错误请在 [GitHub Issues](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/issues) 反馈。

**公开插件商店：**尚未提交或获批。OpenAI 的公开规则要求第三方服务集成取得授权，并禁止通过通用目录/Schema 查询加通用执行器代替逐项描述的工具。当前 619 项能力目录仍使用通用执行器，需要调整公开工具接口；WPS 分发许可、开发者验证、政策页、审核账号与审核通过也尚待完成。ZIP 只登记连接配置，实际操作由云端服务完成。

## Official references / 官方依据

- [Upload and submit a plugin](https://developers.openai.com/plugins/deploy/submission)
- [Plugin package format](https://developers.openai.com/plugins/build/plugins)
- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
- [Sites-hosted personal plugin flow](https://learn.chatgpt.com/docs/extend/mcp)
