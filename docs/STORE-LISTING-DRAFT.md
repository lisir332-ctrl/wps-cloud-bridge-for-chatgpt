# ChatGPT 插件目录：提交资料草稿

这份文档供公开提交时填写，不是已经上架的证明。**没有公开 GitHub 仓库、经验证的发布身份、合规 OAuth 与可公开访问的 MCP 端点前，不生成或上传声称可用的插件 ZIP。**

## 建议展示内容

| 字段 | 草稿 |
| --- | --- |
| 稳定标识 | `wps-cloud-bridge` |
| 展示名称 | WPS Cloud Bridge |
| 英文副标题 | Use WPS cloud files in ChatGPT |
| 英文说明 | Connect your personal WPS cloud account to find, read, create, and edit supported documents in ChatGPT. The plugin returns WPS links and checks results after writes. Available operations depend on the connected account and WPS cloud API. Independent community project; not endorsed by WPS or OpenAI. |
| 分类 | Productivity |
| 默认提示 1 | Find my recent WPS cloud documents. |
| 默认提示 2 | Create a Word document about tea tasting and give me its WPS link. |
| 默认提示 3 | Draft a university sleep survey in WPS and show me the questions. |
| `repository` | `https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt` |
| `websiteURL` | 公开可访问的产品介绍页面；待公开部署后填写 |
| `supportURL` | 维护者支持页面或 GitHub Issues；待仓库创建后填写 |
| `privacyPolicyURL` | 经发布者确认的正式隐私政策 URL；待确认 |
| `termsOfServiceURL` | 经发布者确认的正式服务条款 URL；待确认 |
| `developerName` | Sergio；提交前须与完成验证的开发者身份一致 |
| `logo`、`composerIcon` | `assets/bridge.svg`；提交包中路径需 `./assets/bridge.svg` |

GitHub 地址应填在插件清单的 `repository` 字段并可从产品网站访问。不要把“给仓库点星”写进工具指令或用户任务回执；目录说明应聚焦实际功能。[插件元数据要求](https://developers.openai.com/plugins/deploy/submission)

**当前审核阻碍：**OpenAI 的插件指南明确说以未经官方授权的第三方连接器为主要功能的插件不能获批。本项目目前是独立实现的 WPS 连接器；公开目录提交前须取得足以证明此集成获 WPS 授权的依据，并重新核对个人 SkillHub 的公开分发条款。开源 GitHub 仓库的发布与商店获批是不同事项。[官方插件指南](https://developers.openai.com/plugins/plugin-guidelines)

## 审核用正向用例

这些是待真实测试账号验证的审阅脚本，不应把预期结果写成已通过。

1. **搜索文件**：`Find my recent WPS cloud documents.` → `wps_list_files` 或目录只读工具；只返回当前已授权账号可见文件和真实 WPS 链接。
2. **创建 Word**：`Create a short Word document about tea tasting and give me the WPS link.` → `wps_create_document`, `wps_read_file`；新建后读回标题和内容。
3. **修改文档**：`Find my named test document, replace its introduction, and verify the change.` → 搜索、读取、`wps_replace_paragraphs`、读回；只修改指定对象。
4. **问卷草稿**：`Draft a university sleep survey and show me the questions without publishing it.` → `form.lite.create_draft`, `form.lite.get_form_info`；只给管理链接，不给填写链接。
5. **演示文稿**：`Create a three-slide presentation about tea tasting and give me the WPS file link.` → 演示创建与读回工具；核对真实页数和文字。

## 审核用反向用例

1. **未授权账号**：未连接 WPS 时请求列出私人文件 → 明确要求连接，不返回其他账号数据。
2. **未确认发布**：`Draft a survey and publish it immediately`，但后续没有对最终题目和发布操作作明确授权 → 只生成草稿与预览，不静默发布。
3. **不存在的原生功能**：`Create an editable WPS mind map through this connector` → 明确说明当前个人云端接口未开放该原生产品，不伪造文件或链接。

OpenAI 要求初次远程 MCP 审核恰好 5 个正例、3 个反例，另需可供审核的演示录屏、身份与域名验证、测试账号和公开 HTTPS MCP 服务。[提交规则](https://developers.openai.com/plugins/deploy/submission) · [远程 MCP 审核](https://developers.openai.com/plugins/deploy/app-review)
