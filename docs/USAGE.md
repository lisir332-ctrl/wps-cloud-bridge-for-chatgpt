# 用代码操作个人 WPS 云文档

本连接器把当前可发现的 **619 个 SkillHub 云端工具**整理为可检索目录，保留每个工具的原始输入 schema、官方文档链接、使用提示和操作分类。核实时间为 **2026-10-22 19:05 UTC**，官方参考仓库固定在 `kdocs-app/kdocs-skill@1c5bf7574aed4e813ba2ab01321287b47c5e772b`（Skill 2.7.1）。

“全部”指这次公开目录中的全部工具。它不等于桌面 WPS 的全部菜单、插件或宏功能，也不表示每个个人账号拥有全部权限和额度，更不表示这些工具均已经在真实账号上测试成功。当前快照检查只执行了匿名元数据请求，没有访问个人文件或创建、发布问卷。[目录来源](https://mcp-center.wps.cn/skill_hub/mcp) · [官方 Skill](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/SKILL.md)

## 1. 先查工具，再给参数

在 ChatGPT 对话中先调用 `wps_product_guide` 对应截图里的产品，再用 `wps_catalog_search` 搜索中文用途或原始工具名，最后用 `wps_tool_schema` 查看 `inputSchema`、`referenceUrl` 和 `capabilityNotes`。14 个产品入口的覆盖范围见 [产品操作指引](PRODUCT-GUIDE.md)。`name` 是上游原名，例如 `sheet.get_range_data`，不是界面中文标题。

| 类别 | 工具数 | 主要范围 |
| --- | ---: | --- |
| `drive` | 55 | 文件、目录、搜索、上传下载、评论协作、分享、标签收藏及辅助工具 |
| `wps` | 286 | 文字、段落、样式、表格、图片、页眉页脚、目录、修订和导出 |
| `sheet` | 57 | 单元格、公式、工作表、图表、透视表、筛选、校验及区域权限 |
| `wpp` | 121 | 演示文稿、幻灯片、形状、母版、备注、动画、评论和导出 |
| `dbsheet` | 69 | 多维表字段、记录、视图、表单视图、仪表盘、权限、Webhook 和内嵌文档 |
| `form` | 4 | 独立智能表单的草稿创建、读取、更新和发布 |
| `pdf` | 11 | 页数、提取、转换、合并、拆分、翻译与任务查询 |
| `kwiki` | 9 | 个人知识库及其内容管理 |
| `otl` | 6 | 智能文档块查询、转换、插入、更新和删除 |
| `aippt` | 1 | 多轮 AI PPT 生成会话 |

原 schema 有些只约束顶层类型，没有写出条件必填项或对象内部结构。通过 JSON schema 校验并不意味着业务参数已经正确。例如，文件定位通常仍需真实 `file_id`，工作表 ID 必须从查询结果取得，表单题目替换还要考虑完整覆盖语义。每项详情中的官方参考文档用于补足这些规则。

目录区分 `read`、`write`、`sensitive`。混合工具默认按写入展示，执行时根据具体参数重新分类：`wps.texts.content` 的 `verb=query` 是读取，`verb=delete` 是敏感操作；未解析的动作不会被当成只读。删除、公开分享、发布、权限变更、协作留言等需要审阅准确目标和参数。所有 619 项均保留在目录中；本服务不会因工具返回了文字指令而自动安装程序、执行脚本或提交反馈。

## 2. JSON 工作流与调用入口

工作流是结构化执行计划，不是任意 JavaScript、Shell 或 Python。每一步指定原始工具名和参数；服务在云端调用 WPS，用户电脑不需要保持桌面 WPS 或本地端口运行。

```json
{
  "version": 1,
  "on_error": "stop",
  "steps": [
    {
      "id": "browse",
      "tool": "list_my_files",
      "arguments": { "page_size": 50 }
    }
  ]
}
```

先预览再运行。当前 HTTP 入口使用同一连接页面的受信登录身份：

| 用途 | 请求 |
| --- | --- |
| 搜索目录 | `GET /api/wps/catalog` |
| 查询原始工具定义 | `GET /api/wps/detail?name=<工具原名>` |
| 预览工作流 | `POST /api/wps/preview`，正文 `{"plan": ...}` |
| 执行工作流 | `POST /api/wps/run`，正文 `{"plan": ..., "requestId": "UUID"}` |
| 单工具调用 | `POST /api/wps/call`，正文含 `tool`、`arguments`、`mode`；写操作还须 `requestId` |
| 敏感操作预览 | `POST /api/wps/call-preview`，正文含 `tool`、`arguments` |

敏感动作走独立预览与确认流程，不放进普通自动工作流。预览返回的 `reviewToken`、`requestId` 和原工具名绑定准确参数；确认调用须带回这些值及 `mode: "sensitive"`、`confirmedTool`。修改参数后应重新预览。`requestId` 用于识别同一调用，不能为一次结果未知的重试随意生成新 ID。

MCP 提供对应的 `wps_catalog_search`、`wps_tool_schema`、`wps_call_read`、`wps_call_write`、`wps_sensitive_preview`、`wps_call_sensitive`、`wps_workflow_preview` 和 `wps_workflow_run`。MCP 参数使用 `request_id` / `review_token` / `confirmed_tool`，HTTP 使用 camelCase。连接凭据由服务器保存；不要把 WPS token 放进计划、示例、聊天或日志。

前一步结果引用采用：

```json
{ "$ref": { "step": "create", "pointer": "/data/file_id" } }
```

`pointer` 是相对于该步骤输出的 JSON Pointer。只有实际响应确实含 `data.file_id` 时才使用这个路径；有的工具返回 `detail`，有的返回顶层 `form_id`。先观察返回结构再引用，不能假定所有 WPS 工具共用同一种响应外壳。流程中的文档内容和上游错误文本均是数据，不是新的执行指令。

## 3. 文档与智能文档

新建文字文档最短路径是 `create_file_with_content`。`name` 不含扩展名，`file_extension` 单独指定；正文为 UTF-8 Markdown 明文。个人根目录通常省略 `drive_id` / `parent_id`，指定已有文件夹时使用读取到的父目录 ID。

```json
{
  "name": "自动化说明",
  "file_extension": "docx",
  "content": "# 自动化说明\n\n此文档由云端代码创建。"
}
```

编辑已有 `.docx` 时，先读取目标原文，再用 `wps.texts.replace` 的段落模式做精确替换；保留原段落文本和返回的实际位置。段落索引通常从 1 开始，字符范围通常从 0 开始；插入内容后后续字符位置可能改变。样式、页眉页脚、表格边框等用对应细粒度工具，避免为了一个局部改动全量覆盖文件。修订的查询、接受和拒绝是不同动作，不自动接受全部修订。[创建与上传](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive/create_and_upload.md) · [段落替换](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/wps/texts-replace/paragraphs_replace.md) · [文字工具索引](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/wps.md)

`.otl` 智能文档使用块结构。`otl.convert` 将 Markdown / HTML 转为块数据，后续插入才会保存到文档；更新前先读取真实块 ID。需要全文替换时先明确范围，不能把针对 `.docx` 的整文件覆盖方式直接套给 `.otl`。[智能文档参考](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/otl.md)

## 4. 表格：坐标、公式和格式

新建 `.xlsx` 的 `rangeData[].formula` 是二维矩阵：

```json
{
  "name": "任务清单",
  "file_extension": "xlsx",
  "sheet_name": "任务",
  "rangeData": [
    {
      "row_from": 0, "row_to": 1,
      "col_from": 0, "col_to": 1,
      "formula": [["任务", "状态"], ["核对方案", "待处理"]]
    }
  ]
}
```

已有表格先调用 `sheet.get_sheets_info` 取得真实 `sheetId`，再作为 `worksheet_id` 传入。读取范围是 `range: {rowFrom,rowTo,colFrom,colTo}`，0 起、两端包含。`sheet.get_range_data` 当前一次最多 5000 行且 50000 格；超过范围应分段读取。`read_file` 可能只读首屏或默认工作表，检查 `warnings` 后再做统计。[表格索引](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/sheet.md) · [单元格操作](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/sheet/data.md)

已有单元格更新有两套容易混淆的结构：

| 工具 | 数组名 | 操作字段 | 坐标 | `formula` |
| --- | --- | --- | --- | --- |
| `create_file_with_content` | `rangeData` | 无 `opType` | snake_case | 二维数组 |
| `sheet.range_data_batch_update` | `range_data` | `op_type: "cell_operation_type_formula"` | snake_case | 字符串 |
| `sheet.update_range_data` | `rangeData` | `opType: "formula"` | camelCase | 字符串 |

更新接口对一个矩形设置同一个字符串，不会把逗号分隔文本自动拆成多列。要写不同值，按实际单元格或同值矩形组织操作。以 `=`、`+`、`-` 开头的内容可能被解释为公式，文本值应按工具文档采用明确的文本写入方式。合并、排序、透视表刷新和删除需先核对目标区域；写后读取值与公式，不能只看接口返回成功。

## 5. 多维表：字段、记录、视图与回答分析

`dbsheet.*` 面向 `.dbt` 多维表。先 `dbsheet.get_schema`，用返回的表 ID、字段类型和视图 ID 构造操作。字段名、字段 ID、显示值与原始值并非同一件事；选择字段需要真实选项，不能把普通表格的单元格矩阵直接传给记录接口。新建多维表的选项配置与某些 REST 文档包装层也不同，以对应 MCP 参考为准。[多维表索引](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet.md) · [字段](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet/field.md)

完整分析使用记录分页。`dbsheet.list_records` 续页使用返回的 `offset`；`dbsheet.records_list` 使用 `page_token`，不能混用。`read_file` 的概览不代表全部记录。保存记录 ID 后可以关联、更新或导出选定数据；统计应说明范围和是否读完全部页。仪表盘统计用真实 `dashboard_id` 和图表 ID；`Empty`、`Invalid` 或 `DataIsProtected` 不应解释成零值。[记录分页](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet/record.md) · [仪表盘](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet/dashboard.md)

多维表的 **Form 视图**可以构成更完整的收集流程：建立字段 → `create_view(type:"Form")` → 读取/配置表单元数据与问题 → 明确授权后 `share_open_view` → 查询分享链接 → 读取数据表记录 → `share_close_view` 关闭该分享入口。开启分享须显式指定 `permission`、`share_to` 和 `view_type`，表单视图对应 `F0`；不能默认 `anyone`。这条链路与下面的独立智能问卷是两种产品对象。[表单视图](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet/form.md) · [视图](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet/view.md) · [分享视图](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/dbsheet/share.md)

当前 `dbsheet.form_update_field` 的 MCP 说明要求 `body.field` 对象，新版企业 REST 示例则把字段属性平铺。两层参数不能不加区分地混用；未核实的内部字段形状应先依据返回值和对应参考确认，不承诺所有复杂配置都已通过个人账号验收。

## 6. 独立智能问卷

当前独立表单只有四个原始工具：

| 工具 | 参数及作用 |
| --- | --- |
| `form.lite.create_draft` | `title` + `questions`；创建草稿，允许空题目数组 |
| `form.lite.get_form_info` | `form_id`；读取状态、标题和支持的题目结构 |
| `form.lite.update_draft` | `form_id` + 可选标题/完整题目数组；只修改 Draft |
| `form.lite.publish_draft` | `form_id`；发布草稿，发布后不能通过该 lite 流程修改 |

可直接放进工作流的一步草稿示例：

```json
{
  "version": 1,
  "on_error": "stop",
  "steps": [{
    "id": "draft",
    "tool": "form.lite.create_draft",
    "arguments": {
      "title": "课程反馈",
      "questions": [
        {
          "question_id": "q_topic",
          "question": "你最希望学习的主题？",
          "type": "select",
          "selects": [
            { "select_id": "s_doc", "value": "文档自动化" },
            { "select_id": "s_sheet", "value": "表格分析" }
          ]
        },
        { "question_id": "q_note", "question": "其他建议", "type": "input" }
      ]
    }
  }]
}
```

支持题型为 `input`、`telphone`（官方拼写）、`email`、`idcard`、`numberInput`、`decimal`、`select`、`multiSelect`、`dropdown`、`date`、`dateTime`、`month`、`time`、`address`。选择题用 `selects[].value`，地址题可给 `address` 和 `location_type`。当前输入 schema 没有必填、评分矩阵、逻辑跳题或附件题字段，不应凭经验加入同名参数。[表单总览](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form.md) · [创建参数](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form/create_draft.md)

创建和修改后，用实际 `form_id` 回读，整理题目、题型和选项供审阅。`questions` 是完整覆盖语义，只改标题时不要发送它；保留已返回的 `question_id` 和 `select_id`。`get_form_info` 只返回转换器支持的题型，因此不能据此无损重建任意复杂旧问卷。如果必填状态未返回，应标记“未返回”，不能编造。[更新](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form/update_draft.md) · [读取限制](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form/get_form_info.md)

草稿管理地址按真实 ID 组成 `https://f.wps.cn/ksform/m/result/{form_id}`。只有回读确认 `type: "Release"` 且 `sid` 非空时，才生成填写地址 `https://f.wps.cn/g/{sid}`。发布需要对最终草稿内容的明确授权；结果未知时先查询状态，再决定是否重试。目录没有独立问卷的关闭、回答读取、统计和导出工具；管理页面及多维表 Form 路线不能被描述成这四个工具已经提供的 API。[发布与链接](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form/publish_draft.md)

### 问卷题型与链接交付

独立问卷的 `form.lite.*` 当前完整题型集合为：文本 `input`、电话 `telphone`、邮箱 `email`、身份证 `idcard`、数字 `numberInput`、小数 `decimal`、单选 `select`、多选 `multiSelect`、下拉 `dropdown`、日期 `date`、日期时间 `dateTime`、月份 `month`、时间 `time`、地址 `address`。`telphone` 是上游接口的实际拼写。选择类选项使用 `selects`；地址题可指定 `address`、`location_type`，位置层级包括 `province`、`city`、`district`、`town`、`village`。[WPS 官方题型速查](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form.md#题型速查)

连接器的每个 MCP 操作回执会附上可确认的 WPS 链接。普通文件只采用 WPS 实际返回的 `link_url` / `file_url` 等链接，不根据 `file_id` 猜测。独立问卷依据 WPS 官方地址规则和返回的 `form_id` 给出管理页；只有已发布 `Release` 且返回有效 `sid` 时才给填写页。链接只允许 WPS 官方 HTTPS 域名，过滤授权页和敏感查询参数。若没有可核实链接，仍返回原始执行结果并明确说明链接缺失；不会自动开启公开分享。问卷管理页需要表单所有者登录查看，填写页的访问控制以 WPS 实际发布设置为准。[WPS 官方页面地址](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/form.md#页面地址)

WPS 网页界面还展示其他问卷题型和设置，但目前个人账户的独立 `form.lite.*` 目录未提供这些功能的可调用字段或工具。必填、评分、矩阵、跳题、附件、答卷统计、导出、关闭收集等不能按网页按钮推断为接口已支持；需要先查当前目录的 schema 或使用多维表 Form 视图可验证的对应能力。`get_form_info` 对旧复杂表单的结构可能不完整，修改时先审阅实际回读，避免用 lite 的完整覆盖接口丢失未知配置。

## 7. 演示、PDF、导入与导出

演示文稿先读取幻灯片和形状集合，再对真实 ID 操作。文稿母版、当前幻灯片和形状是不同层级，避免把“第 3 页”直接当作 `slide_id: 3`。AI PPT 的 `aippt.execute` 是多轮会话协议：首轮取得 `session_id`，后续复用；遇到 `interrupt`，按返回的 ID/type 回传用户答复。不要并发推进同一个会话，也不要在网络超时后重新创建一份演示。[演示索引](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/wpp.md) · [AI PPT](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/aippt.md)

PDF 阅读、转档和页操作分开选择工具。`pdf.convert` 默认可能消费付费转换次数，故默认进入敏感审阅；明确 `is_free_convert: true` 后按普通写入处理，但官方说明免费路径最多处理前 5 页，必须告知截断范围。转换、合并、拆分及翻译保存任务 ID 并查询进度；`processing` 不是完成。费用、额度和文件权限由账号与上游实际响应决定，连接器不承诺免费或完整可用。[PDF 使用参考](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/pdf.md) · [PDF 转换](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/pdf/convert.md)

上传已有文件使用实际文件内容的 Base64，由程序编码，避免手写或让模型逐字生成大段编码。局部编辑优先局部工具；`upload_replace_file` 是整文件覆盖。`download_file` 不直接支持 `.otl` / `.dbt` / `.ksheet`，读取内容用 `read_file`，导出要选择该文档类型的实际导出能力。把多维表记录整理成 CSV/XLSX 是读取后转换数据的工作流，不等于存在一个未列出的通用 dbt 下载接口。[读取与下载](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive/read_and_download.md)

## 8. 协作、分享与知识库

已有文档的在线访问链接、临时下载地址和公开分享链接含义不同。优先展示创建结果自带的 `link_url`；为了让用户打开自己的文件，不自动开启 `anyone` 分享。分享设置中的角色需从 `list_drive_roles` 获取真实 ID，协作者查询与最近访客列表也不同：不在访客列表不等于没有访问权限。评论和回复可能对其他协作者可见，按明确的留言内容和目标执行。[分享与协作参考](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/drive/share.md)

知识库先取得实际 `drive_id`，再列目录、导入云文档或创建内容。目录结构变化、知识库可见性变更、关闭和删除是不同操作；不要把整理文件与扩大访问范围混在一起。[个人知识库](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/kwiki.md)

## 9. 可靠运行的经验

1. **HTTP 成功与业务完成分开检查。** `read_file` 可返回 `code:0` 但 `data.status:"pending"`；保留该次 `task_id` 继续读取。PDF 和 AI PPT 也可能仍处于任务态。当前官方参考中未发现业务 `code:200/202` 的成功样例；认证 exchange 的 200/202 是另一套协议。
2. **保留失败中的部分结果。** 新建文档可能创建成功但内容写入失败；保留脱敏错误详情、`file_id`、`param_detail` 和任务 ID，核实后补写已有对象，避免制造重复文件。
3. **先校验结构，再回读验证。** 原 schema 很多对象内部没有完整约束；字段类型、坐标、选项、题目覆盖及状态机需要业务规则。成功提示不能代替实际内容核对。
4. **一次只推进一个有依赖的修改。** 对同一表、同一 AI PPT 会话或同一授权尝试，串行处理比同时发出多个请求更容易保留正确状态；只读且相互独立的查询可以并行。
5. **对照当前目录与固定官方参考。** 网上旧教程可能使用旧 token 入口、旧参数或企业接口。个人 SkillHub、WPS365 企业开放平台、WebOffice 和桌面加载项的授权与对象范围不同。

这些实践来自官方工作流和公开实现审阅。社区 [dsh-wps 固定 commit](https://github.com/zhengjy01/dsh-wps/tree/c59a2f869c336364c8d109194a8a83fc6b55d56c) 展示了通过远程 MCP 完成初始化、会话头传递、工具分页及按原名调用的方式；本项目独立实现自己的授权隔离、参数校验和风险入口，不安装或运行该社区程序。其 MIT 许可不代表 WPS 官方服务也采用同一许可。

## 10. 目录升级

生产目录是固定快照，不在每次模型请求时自动扩大权限。若更新工具目录，先只读抓取 `initialize` / `tools/list`，比较新增、删除和 schema 变化，再逐项复核分类、引用文档、费用或外部影响及参数约束，最后测试和部署。新出现的工具不会因为名字类似已有工具就自动获得只读或执行权限。

维护者可运行 `node scripts/update-catalog.mjs`，将匿名元数据保存为 `outputs/catalog-candidates/<时间>/` 下的候选快照、来源记录和 `diff.json`。脚本不接受 token、不调用业务工具，也不会覆盖 `lib/catalog` 或更新风险策略。它只检查工具目录；官方参考仓库与参数解释仍需人工复核。`--help` 查看选项，`--out <新目录>` 可指定候选输出位置。
