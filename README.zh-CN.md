# WPS Cloud Bridge for ChatGPT

[English](README.md) · [简体中文](README.zh-CN.md)

一个面向 ChatGPT 的个人 WPS 云文档开源连接器。用户连接自己的 WPS 账号后，可以在对话中查找、读取、创建和编辑受支持的云文件。连接器会返回真实的 WPS 链接，并在写入后读回核对结果。

**这是独立社区项目，并非 WPS 或 OpenAI 官方产品，也未获得其背书。** GitHub 仓库公开的是源码；当前托管的连接服务仍为私有站点，**尚未获批或发布到 ChatGPT 公共插件目录**。[OpenAI 插件规则](https://developers.openai.com/plugins/plugin-guidelines)明确限制未经适当授权的第三方连接器。

项目由 **[Sergio](https://github.com/lisir332-ctrl)** 发起并维护，借助 **Codex** 进行开发。详见[维护者与致谢](MAINTAINERS.md)。

## 已覆盖的云端能力

| WPS 产品 | 当前可用路径 |
| --- | --- |
| 文字、表格、演示、PDF | 云文件操作、结构化编辑与转换，取决于账号权限 |
| 智能文档、智能表格 | OTL 内容块操作、KSHEET 表格操作 |
| 智能表单 | 草稿创建、读取、更新和发布；当前接口开放 14 种题型 |
| 多维表格 | 字段、记录、视图及独立的 Form 视图流程 |
| AI PPT | 基于会话的生成、中断处理与任务状态核对 |

目录快照包含 2026-10-22 从 WPS 个人 SkillHub 获取的 **619 项工具**。目录中有工具不代表每个账号都有相应权限或会员额度，也不代表每项操作都经过真实账号验收。当前个人云端路径未开放思维导图、流程图、海报、语音速记及 WPS 笔记的原生编辑接口。详见[产品指引](docs/PRODUCT-GUIDE.md)与[操作经验](docs/USAGE.md)。

## 使用方式

1. 在受支持的托管环境登录，并在简洁的授权页面连接自己的 WPS 账号。
2. 在 ChatGPT 中选择对应 MCP 连接，直接说出目标，例如“创建一份介绍品茶的 Word”或“查找最近的 WPS 云文档”。
3. 连接器确认目标和准确的工具参数，执行云端操作，尽可能读回验证，并返回可打开的 WPS 链接。

授权页只负责连接、状态与断开；文档操作在 ChatGPT 对话中完成。问卷默认先保存为草稿。发布、删除、分享、权限修改及可能消耗会员权益的操作另行审阅。免费版与会员版能力以 WPS 的实际业务返回为准。

## 安全与托管边界

当前部署依赖受控 Sites 平台注入的可信 ChatGPT 用户身份、D1 数据库和服务端加密密钥。`POST /mcp` 提供工具发现与调用。用户身份不从请求正文或客户端自填的 Header 获取。WPS 凭据按用户隔离加密保存；执行去重记录不保存文档正文或令牌。

**不要把本仓库直接部署成匿名公开 Worker。** 换用其他托管平台时，必须增加经验证的身份层，并由代理移除客户端伪造的身份 Header。进入 ChatGPT 公共插件目录还需满足可审核的认证、发布者身份、政策页面、测试账号，以及 WPS 对公开第三方集成的授权要求。详见[部署与公开发布边界](docs/DEPLOYMENT.md)。

## 本地开发

需要 Node.js 22.13+ 与 pnpm。公开仓库中的托管配置使用零值项目 ID；部署到 Sites 前，请换成自己创建的项目 ID。

```sh
pnpm install --frozen-lockfile
pnpm build
node tests/run.mjs
pnpm exec tsc --noEmit
```

托管时将 D1 绑定为 `DB`，设置最终 HTTPS `SITE_ORIGIN`，并把 32 字节随机密钥的 64 位十六进制值保存为 `WPS_ENCRYPTION_KEY` secret。不要提交令牌、私人文件、数据库导出或真实密钥。构建通过、模拟测试通过与真实 WPS 账号验收是不同的证据。详见[部署说明](docs/DEPLOYMENT.md)和[协议说明](docs/PROTOCOL.md)。

## 社区与维护者

欢迎在 [Discussions](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/discussions) 提问或讨论功能。贡献前请阅读[贡献指南](CONTRIBUTING.md)、[社区行为准则](CODE_OF_CONDUCT.md)、[安全政策](SECURITY.md)和[第三方许可说明](THIRD_PARTY_NOTICES.md)。版本变化见[更新记录](CHANGELOG.md)。

项目采用 [MIT License](LICENSE)。如果觉得有帮助，可以为 [GitHub 仓库](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt)点星，或参与改进。

维护者：[Sergio](https://github.com/lisir332-ctrl)。另一个独立项目：[HUC Free AI Hub](https://free.huc.us.ci/)。
