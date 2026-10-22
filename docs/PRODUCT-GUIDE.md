# WPS 新建菜单：个人云端连接器操作指引

依据用户提供的 14 项新建菜单截图、金山文档官方产品页、官方 Skill 参考和本连接器当前个人 SkillHub 目录核对。**网页可点击不等于个人账号的远程接口已开放。** 表中“可调用”只表示目录提供相应工具，具体权限和会员额度仍由用户账号操作回执决定。连接器以 ChatGPT 对话为入口，WPS 在云端执行，完成后读回并返回真实链接。

| 截图入口 | 个人云端路径 | 当前状态与关键操作 |
|---|---|---|
| 文字 | DOCX + `wps.*` | 可调用；读取、段落修改、样式与读回 |
| 演示 | PPTX + `wpp.*` | 可调用；页面与形状操作，需核对 ID 和视觉结果 |
| 表格 | XLSX + `sheet.*` | 可调用；先取工作表 ID，写入后核对公式与值 |
| PDF | `pdf.*` + 云文件 | 可调用；读取、转换与异步任务状态；会员额度依回执确认 |
| 智能文档 | OTL + `otl.*` | 可调用；按块读取和写入，转换结果要实际保存 |
| 智能表格 | KSHEET + `sheet.*` | 可调用；具体表格功能按工具 schema 判断 |
| 智能表单 | `form.lite.*` | 可调用；14 种题型，先草稿和读回，发布需单独确认 |
| 多维表格 | DBT + `dbsheet.*` | 可调用；字段、记录和视图；Form 视图与独立问卷分开 |
| 思维导图 | 无对应原生工具 | 当前个人云端目录未开放可编辑脑图操作 |
| 流程图 | 无对应原生工具 | 当前个人云端目录未开放可编辑流程图操作 |
| 海报 | 无对应原生工具 | 当前个人云端目录未开放 WPS 海报编辑操作 |
| 语音速记 | 无对应原生工具 | 当前个人云端目录未开放录制/转写操作 |
| AIPPT | `aippt.execute` | 可调用；会话可能中断或异步，完成前不交付成片 |
| 笔记 | 无对应个人云端工具 | WPS 笔记单独 MCP 依赖本地客户端，不属于本云连接 |

## 给 ChatGPT 的操作顺序

1. 用户说出产品或任务后调用 `wps_product_guide`，确定当前个人云端是否有原生工具。
2. 对可调用项目，先搜索 `wps_catalog_search`，再读取 `wps_tool_schema`；只用本次可核对的参数。
3. 创建、修改之前读取目标；写入使用唯一 `request_id`，避免不确定结果后重复创建。
4. 按实际回执检查业务状态；异步任务等待完成，完成后读回内容与结构。
5. 返回 WPS 给出的文档链接。独立问卷按官方 `form_id` 管理页规则生成；发布且读回 `type=Release` 和 `sid` 后再给填写链接。若缺链接，明确说明，不用文件 ID 猜 URL。
6. 如果 WPS 明确拒绝会员权益且未产生结果，才考虑可用的免费回退，并说明内容或页数差异。

## 产品边界

思维导图、流程图和海报可以作为单独格式的内容方案讨论，但生成 PNG 再上传只得到一张图片云文件，不能称为 WPS 原生可编辑产品。WPS 笔记官方 MCP 需要本地客户端保持运行，因此不能接到本项目的纯云授权链路。企业 WPS 365 OpenAPI 与个人 SkillHub 的授权、权限和产品范围不同，不能直接替换。将来个人目录新增原生工具时，先复核 schema 和账号权限，再更新本表与策略。

## 回源

- [金山文档官方产品概览](https://ww.kdocs.cn/welcome)
- [金山文档官方 Skill 参考](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/SKILL.md)
- [独立表单操作](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form.md)
- [多维表操作](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet.md)
- [AI PPT 操作](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/aippt.md)
- [WPS 笔记官方接入说明](https://ainote.kdocs.cn/wps-notes-hub/tutorial/getstarted/)
- [WPS 企业开放平台概述](https://365.kdocs.cn/3rd/open/documents/app-integration-dev/guide/overview)
