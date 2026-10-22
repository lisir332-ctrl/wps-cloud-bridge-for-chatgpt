# 个人 WPS 云连接协议记录

核实日期：**2026-10-22（UTC）**。本文区分已观察到的协议、官方使用约束和本项目的实现约束；不表示已经完成真实账户验收。来源见 [REFERENCES.md](./REFERENCES.md)。

## 1. 适用通道

本项目面向 **WPS 个人账号的金山文档 SkillHub**。官方 `kdocs-skill` 2.7.1 说明配套 `kdocs-cli` 仅支持个人账号，并将企业账号引导至 WPS365 CLI。连接器运行在云端；用户不需要保持桌面 WPS、个人电脑或本地监听端口运行，但仍需要托管服务和网络。

**WPS365 企业开放平台是独立通道**，有自己的应用、权限和 OAuth 流程。不能把企业 OAuth 的有效期、刷新接口、应用权限或企业 MCP 工具列表套用于个人 SkillHub。WebOffice 是另一种在线编辑集成，并不是本项目的个人账号授权接口。

## 2. 个人账号授权

| 用途 | 已核实地址 / 请求 |
| --- | --- |
| 用户打开官方授权页 | `https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=<UUID>` |
| 官方引导页生成的登录地址 | `https://account.wps.cn/login?cb=<URL-encoded callback>` |
| 官方引导页生成的回调 | `https://api.wps.cn/office/v5/ai/skill_hub/users/callback?code=<UUID>` |
| 云端轮询交换 | `POST https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange`，JSON `{"code":"<UUID>"}` |
| 官方引导页取消本次授权 | `POST https://api.wps.cn/office/v5/ai/skill_hub/token/reject`，JSON `{"code":"<UUID>","reason":"user_cancelled"}` |
| 官方手动入口 | `https://www.kdocs.cn/latest` → 右上角主菜单 →「金山文档Skill」 |

官方 `auth.md` 确认生成 `auth_code`、打开引导页、轮询和取消流程；引导页公开 JavaScript 确认官方登录与回调地址。`exchange` 的确切请求及兼容响应解析来自审阅的社区实现，尚未使用真实账户验证。此流程不需要 localhost 回调。

社区实现接受顶层或 `data` 内的响应字段：数值 `code: 200` 且存在非空 `token` 才算成功，可能同时返回 `expires_in`；`403` 表示拒绝，`409` 表示用户取消。官方说明另列 `403001` 为企业账号限制，不能把所有 HTTP 403 都解释成企业账号。2026-10-22 对全新未批准随机码的实测为 HTTP 200、`{"code":202,"message":"waiting for login"}`。未知数字代码不无限视为 pending。参考实现等待 5 分钟、本项目 0.2 等待 10 分钟均为本地实现选择，并非官方 token 期限。

没有找到个人通道的公开 `refresh_token` 协议或保证的 token 有效期。若返回有效的 `expires_in`，应记录过期时间；已知失效时要求重新授权。取消尚在进行的授权不等于撤销此前已签发的 token。本服务的“断开”应准确描述为删除本服务持有的连接凭据，除非另有已验证的 WPS 撤销接口。

实现约束：授权随机码绑定到发起用户和有限有效期；轮询不得跨用户领取，终态不可重放；同一尝试不得并发兑换；断开后在途兑换不得恢复连接。刷新后的同源账号页面可取回本人的 pending 链接，MCP 状态工具不返回授权码。备用手动 token 只能在受保护的页面密码框输入，经服务器只读验证后加密保存，不进入浏览器响应、模型返回值或日志。本站面向 MCP 客户端的凭据与 WPS 上游 token 是不同凭据。

## 3. 上游 MCP

端点：`https://mcp-center.wps.cn/skill_hub/mcp`。使用 HTTPS POST JSON-RPC 2.0；业务调用携带 `Authorization: Bearer <WPS token>`。请求支持 `Content-Type: application/json`，接收声明 `application/json, text/event-stream`。

顺序为 `initialize` → `notifications/initialized` → `tools/list` / `tools/call`。本次元数据请求使用协议版本 `2024-11-05`。若上游返回 `mcp-session-id`，后续携带该会话头；工具分页以实际 `nextCursor` 为准。客户端名称与请求来源应标识本项目，不冒充官方 CLI 或参考项目。

```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "tools/call",
  "params": {
    "name": "sheet.get_range_data",
    "arguments": {
      "file_id": "<observed file id>",
      "worksheet_id": 3,
      "range": { "rowFrom": 0, "rowTo": 4, "colFrom": 0, "colTo": 2 }
    }
  }
}
```

上例仅说明已核实的参数形状；示例 ID 不是真实文档。上游工具原名包含点号，不能把客户端展示名称直接当作上游名称。返回还可能在 MCP `content[].text` 内包含业务 JSON；需区分 JSON-RPC 错误、MCP `isError`、业务 `code` 和业务 `result`，不要以 HTTP 状态单独判断完成。

## 4. 元数据验证及工具边界

本次仅以匿名请求验证：`initialize` 返回 HTTP 200、`SkillHub MCP` / `1.0.0`；初始化通知返回 HTTP 202；`tools/list` 返回 HTTP 200、**619 个工具**，没有下一页游标。**未登录、未获取用户 token、未调用任何业务 `tools/call`。** 这证明元数据可达，不证明某一账号具备全部权限或工具能成功读写。

0.2 将完整 **619 项**目录与原始 schema 固定在 `lib/catalog/`，经搜索、参数、只读、普通写入和敏感操作入口使用。分类依据工具语义、官方说明与实际参数；普通计划排除敏感动作，单独精确预览后执行。新增上游目录须重新拉取并审阅，不执行模型猜出的任意工具名。上游的 619 个工具给出了完全相同的 annotations，包括 `destructiveHint: true`；这些默认值不能代替逐工具分类。

| 上游原名 | 本次 live schema 的顶层 `required` | 还需本地检查 |
| --- | --- | --- |
| `list_my_files` | 空 | 分页边界、实际返回的盘与文件标识 |
| `search_files` | 空 | 明确分页大小；搜索索引可能延迟 |
| `read_file` | 空 | `url` / `link_id` / `file_id` 三选一；pending 任务和截断 warnings |
| `create_file_with_content` | `name`, `file_extension` | 按类型校验正文或表格矩阵；创建失败不可盲目重试 |
| `get_file_info` | 空 | 明确文件定位 |
| `get_file_link` | 空 | 分享副作用未实测，见下文 |
| `sheet.get_sheets_info` | 空 | 明确文件定位，读取真实 sheetId |
| `sheet.get_range_data` | `range` | 显式 worksheet_id、四个整数坐标、区域大小 |
| `sheet.range_data_batch_update` | `worksheet_id`, `range_data` | 每项操作类型、坐标和值；不能只信松散 schema |
| `sheet.update_range_data` | `rangeData` | 显式 worksheet_id、camelCase 坐标、formula 字符串 |
| `upload_replace_file` | `file_id`, `content_base64` | 全文覆盖的目标、格式和用户授权范围 |
| `wps.texts.content` | `scope`, `verb` | 同一工具也支持删除；必须限制 scope / verb |
| `wps.texts.replace` | 空 | 明确替换模式、原文、目标文件和多处匹配处理 |
| `wps.texts.search` | `find_text` | 明确文件定位；写入后原有位置可能失效 |

“空”只表示 schema 未声明必填项，**不表示无参数即可正确完成操作**。上表为常用例子，全部参数以目录与对应官方 reference 为准。

### 表格创建与更新的区别

官方 `drive/create_and_upload.md` 明确：新建 xls / xlsx / ksheet 时，`rangeData` 为对象数组，坐标用 snake_case，`formula` 为**二维矩阵**，例如 `[["姓名", "部门"]]`。`name` 不包含扩展名，扩展名单独传入；个人根目录可省略盘和目录。官方工作流对此比 live schema 更具体，应按工作流校验。

已有表格的 `sheet.range_data_batch_update` 使用 snake_case 坐标和完整 `op_type`，例如 `cell_operation_type_formula`，其 `formula` 是**字符串**，矩形内每格填入同一个值。旧式 `sheet.update_range_data` 则使用 `opType: "formula"` 和 camelCase 坐标，`formula` 仍是字符串。三种结构不能混用。对既有文件，先读实际 worksheet_id 和目标区域，写后读取校验。

### 文档修改与链接

段落替换优先使用已读取的完整原段落，并保留多处匹配跳过保护；全文覆盖、删除、改权限不是普通“编辑”请求的默认动作。创建响应若已含 `link_url`，应直接复用；亦可保留用户输入的原链接。

官方将 `get_file_link` 描述为获取在线访问链接，将 `share_file` 单列为开启共享；但没有找到前者“绝不改变分享状态”的明确保证，也未作真实账户测试。不能把它宣传为已验证无副作用。默认读取流程不自动调用 `share_file`、分享权限设置或授权撤销工具。读取失败不能当作更改文档权限的授权。

## 5. 验收边界

文档/源码审阅与匿名元数据可达性检查已完成。尚未验证真实个人账号授权、token 期限、远程客户端连接、文档读写、工作表更新、权限继承或断开后的 WPS 端 token 状态。上线后的真实账户验收必须明确区分这些事项，不能用 mock 测试替代平台验收结论。

## 6. 0.2 运行时与部分结果

线上 0.1 `/connect` 成功，第一次 `/poll` 于 469 ms 返回 502。真实 workerd 1.20260515.1 复现 `redirect:"error"` 在网络请求前抛 TypeError；`manual`、`cache:no-store`、`credentials:omit` 组合可构造。0.2 使用 manual 并拒绝全部 3xx，凭据不跟随重定向。错误诊断仅记录白名单阶段、数值状态、类型和耗时，不记录 auth_code、token、完整请求或原始网络异常。

官方业务样例以 `code:0` 成功；正文异步抽取为 `code:0,data.status=pending` 并携带真实 task_id。该业务协议与授权交换的 code200/202 分开。创建后的格式处理失败可能已经生成 data.file_id，连接器保留脱敏 partialResult，将该写入标为不确定并要求先核对。D1 原子登记防止相同 request_id 重放，不提供跨新 ID 的全局幂等或 WPS 端事务。

## 7. 0.3 任务验收与代码生成演示

验收报告保存固定检查摘要、时间和本次创建的对象 ID，不保存文档正文、题目数据、原始响应或授权凭据。状态按实际检查区分 passed / failed / pending / uncertain；过期的 running 快照以 uncertain 展示，不由 GET 重跑写入。报告携带 connectionCurrent，用于避免将旧账号验证结果当成新连接的证明。

PPT 创建先对规范化提纲做原子执行登记，再在内存生成 PPTX，调用 `upload_new_file`，显式 `content_format:"pptx"`，从成功响应 `/data/id` 取得新文件 ID。接着 `read_file` 使用 `format:"kdc"` 和 `enable_upload_medias:false`，只解析官方记录的 `slide_containers[].slides[].shape_tree[].textbox.blocks[].para.runs[].text` 结构。pending 保留 task_id；续验是独立只读操作。完成后不复用旧任务编号，不以文本抽取代替视觉检查。

本地生成器和回归检查均不能证明当前用户已成功授权或 WPS 实际账号上传成功。生产授权链路健康探测只检查未批准随机码的等待响应；生成引擎探测只检查固定两页文件生成。这两者与真实账号验收报告分别展示。
