# Plugin ZIP vs. source ZIP / 插件 ZIP 与源码 ZIP

**Target user experience / 目标体验：** install from the ChatGPT Plugin Directory **or** upload a real plugin ZIP from GitHub → connect one's own WPS account → use WPS cloud tools in ChatGPT. 两条入口最终都应做到“安装 → 自己授权 WPS → 在 ChatGPT 中使用”。

## English

**Can I upload the GitHub Release ZIP to ChatGPT Plugins? No.** The v0.8.1 ZIP is a source archive for reading and self-hosting. It has no root `plugin.json` or `mcp.json`, so it is not an installable plugin package. Unzipping the source also does not deploy the hosted MCP server or configure user authentication.

**There is now a separate [plugin-package template ZIP](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/releases/tag/v0.9.0-template.1):** `plugin-package/` contains root `plugin.json`, `mcp.json`, a square icon, and an onboarding skill. Both manifests validate against the Agent Plugins 1.0 schemas. Its MCP URL is deliberately `https://replace-me.example/mcp`, so the public template ZIP cannot connect unchanged. To adapt it, deploy a WPS-authorized HTTPS MCP service with OAuth protected-resource metadata, replace the URL, zip the **contents** of `plugin-package/` so `plugin.json` is at the ZIP root, then use ChatGPT's **With MCP** upload path. A ZIP never hosts the server itself.

**How the current private connector is used:** the Site owner publishes the hosted Site, then installs its companion plugin under **Plugins → Personal → Created by you** and connects a personal WPS account on the Site's authorization page. That flow does not require uploading the source ZIP. Other users cannot install the current private Site merely by downloading the repository.

**When a plugin ZIP becomes appropriate:** OpenAI's public upload flow accepts a package with a valid manifest, MCP configuration, branding assets, and a real hosted HTTPS MCP endpoint. Uploading the ZIP registers metadata; it does not host the server. The endpoint must pass authentication and domain verification, tool scans, and review. A protected server must not be declared as unauthenticated.

The public package is **not ready yet**: this connector needs an authorized WPS distribution path, a public reviewable authentication and demo-account flow, and a public tool surface with individually described operations. The current 619-tool catalog plus generic executor is useful inside the private connector but does not meet OpenAI's public review rule against generic tool discovery followed by a generic executor. Do not upload a placeholder ZIP or claim public Directory availability.

| Distribution path | What remains before anyone can install and authorize |
| --- | --- |
| ChatGPT public Directory | WPS permission for public integration; public multi-user MCP and OAuth; reviewable tools, policies, demo, and approval |
| GitHub plugin ZIP | The same public multi-user MCP and WPS permission; replace the template URL, validate auth, then distribute a configured ZIP |

## 简体中文

**能把 GitHub Release 的 ZIP 直接上传到 ChatGPT 插件页面吗？目前不能。** v0.8.1 的 ZIP 是供阅读或自行托管的源码包，不含根目录 `plugin.json` 与 `mcp.json`，并非可安装插件包。解压源码也不会自动部署 MCP 服务或配置用户认证。

**另有[插件包模板 ZIP](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/releases/tag/v0.9.0-template.1)：**`plugin-package/` 包含根目录 `plugin.json`、`mcp.json`、方形图标和入门技能，两份清单已通过 Agent Plugins 1.0 Schema 校验。公开模板故意使用 `https://replace-me.example/mcp` 占位地址，原样上传无法连接。要使用它，先部署获得 WPS 公开集成授权的 HTTPS MCP 服务并提供 OAuth 资源元数据，替换地址，再把 `plugin-package/` 的**内容**打成 ZIP（让 `plugin.json` 位于 ZIP 根目录），从 ChatGPT 的 **With MCP** 路径上传。ZIP 本身不会运行服务。

**当前私有版的正确用法：**站点所有者先发布 Sites 托管站点，再到 **Plugins → Personal → Created by you** 安装其配套插件，并在站点授权页连接自己的 WPS 账号。这条路径无需上传源码 ZIP。其他人仅下载仓库，无法直接安装当前私有站点。

**未来什么时候可以上传插件 ZIP：**需要有效插件清单、MCP 配置、图标、真实可公开连接的 HTTPS MCP 服务，并完成认证、域名验证、工具扫描与审核。ZIP 只登记插件资料，不负责运行服务；受保护的服务不能冒充“无需认证”。

公共插件包目前**尚未就绪**：还需取得 WPS 对公开分发的授权依据、可供审核的公开认证与测试账号，并把目前的通用目录/执行入口改成逐项明确描述的公开工具。不要上传占位 ZIP 或声称已上架。

| 发布入口 | 所有人都能安装并自行授权前还缺什么 |
| --- | --- |
| ChatGPT 公共商店 | WPS 公开集成许可、多用户云端 MCP 与 OAuth、可审核的工具及政策材料、审核通过 |
| GitHub 插件 ZIP | 同样需要多用户云端 MCP 与 WPS 许可；替换模板地址、验证认证后才能发布已配置的 ZIP |

## Official references / 官方依据

- [Upload and submit a plugin](https://developers.openai.com/plugins/deploy/submission)
- [Plugin package format](https://developers.openai.com/plugins/build/plugins)
- [Plugin guidelines: third-party integrations and tool exposure](https://developers.openai.com/plugins/plugin-guidelines)
- [Sites-hosted personal plugin flow](https://learn.chatgpt.com/docs/extend/mcp)
