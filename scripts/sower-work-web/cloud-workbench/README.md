# 云端关键词 / 链接与文本知识工作台

这是独立云端文件链路；不读取桌面登录、历史、API 密钥或原素材，不运行模型、平台采集、支付或积分操作。

## 接入

`import { createCloudWorkbench } from './cloud-workbench/index.mjs'`，调用 `createCloudWorkbench({runtimeDir})`。runtimeDir 必须是已存在的独立绝对运行目录，不可与源码或 release 混用。

bridge 在 SaaS 会话、管理员权限、CSRF、账号 broker 验证之后调用 `await cloudWorkbench.handle(req,res,{path,identity,site})`，返回 false 才继续其他路由。identity 是 broker 的 `{userId,workspaceId}`，site 是服务端验证的 `{userId,tenantId,userName}`；模块不接收客户端身份头、body 中的租户或账号作为权限来源。四项身份哈希分区，同租户不同用户也不共享文件。

封包复制本目录，包括 `compare-worker.mjs` 和 `workflow/`。没有新增 npm 依赖。Node 24 内置 worker_threads 支持评分隔离；只能由一个 service 进程写同一个 runtime。测试目录可排除。

UI 内部入口 `/cloud-workbench`，对外为 `/sower-work/app/cloud-workbench`。使用同源 cookie。页面 head 引用 `/sower-work/app/_bridge-prefix.js`，初始化状态和记录成功后调用 `window.__sowerCloudNotifyReady?.()`；frame token 校验由桥接前缀负责。

## HTTP 契约

响应 `{success:true,data}`，错误 `{success:false,error:{code,detail?}}`。以下路径均在 `/api/sower/cloud-workbench` 下：

| 方法 / 路由 | 内容 |
| --- | --- |
| GET `/status` | capabilities、文件/速率/worker 门限与实际能力边界 |
| GET / POST `/jobs` | 列表；上传 `{fileName,contentBase64,scope,sourceKind?}`，保留原字节、SHA256 和行证据 |
| GET `/jobs/:id` | 完整范围、去重证据、计划、人工根、市场、草稿 |
| PUT `/jobs/:id/annotations` | `{expectedRevision,humanConfirmed:true,annotations:[{kw,parts,partTypes}]}`，完整覆盖去重词，词根拼合须覆盖原词 |
| PUT `/jobs/:id/market` | `{expectedRevision,scopeVerified:true,complete:true,fileName,contentBase64}`；同一任务只绑定一份市场原件 |
| POST `/jobs/:id/generate` | `{expectedRevision,limit:1..100,category?}`；200 个去重词上限，缺失人气拒绝评分 |
| GET `/jobs/:id/export?format=json或csv` | JSON 完整证据；尚未生成时 CSV 是关键词/词根表，生成后是原引擎固定 20 列草稿 |
| GET `/jobs/:id/original` 或 `/market-original` | 关键词 / 市场原字节，带 `X-Content-SHA256`；HEAD 支持元数据 |
| GET / POST `/knowledge` | 文件列表 / 上传；正文不塞入列表 |
| GET `/knowledge/search?q=...` | 当前分区文件名/正文的字面检索，最多 20 条；不调用智能体或向量服务 |
| GET `/knowledge/:id` 或 `/:id/original` | 正文状态 / 原件 |

CSV 列为 `关键词,人气,来源` 或 `kw,pop,kind`。真实零保留，空白和区间人气为 null，原字段留在 evidence。CSV 账号和工作区由服务端补齐；标准 SW sources JSON 保留其原语义 scope，但不改变存储归属。market JSON 为 `{scope,kind:'sycm-market-rank',rows:[...]}`；scope 的 accountId/workspaceId/platform/categoryId/startDate/endDate/objectId 必须逐项一致。完整性由导入者声明，系统未验证真实平台采集。

复用 `/Users/shaozhuang/Desktop/SowerWork/packages/ecommerce-keyword-workflow` 的 `scripts/core.mjs`、provenance 和 vendor 原字节；原工作流启动校验 vendor SHA256。继承的规则矩阵是 TEST R42 / 1.9.73，不宣称是最新插件生产代码。一词一链接不能替代真实拆词与评分。生成状态始终 draft-needs-review、browserCollectionVerified=false、businessAccepted=false。

TXT/MD/JSON 使用原知识解析的纯文本边界（最多 100 万字符，明确 truncated）；图片只保留原件 image_no_ocr，PDF/DOC/DOCX/XLSX 明确 pending/parser_unavailable。没有桌面向量索引、智能体注入、OCR 或文件解析插件。

## 保护与验收边界

每文件 5 MB / 请求 8 MB；每分区 128 MB、16 个任务、50 个知识文件；每任务 100 次修改、5,000 词、10 个来源。写入全局最多 8 个并发、每分区 2 个，60 次/分钟；导入 20 次/分钟；评分全局 2 个、每分区 1 个、6 次/分钟；worker 128 MB old-generation 限制，20 秒终止阈值，断连终止。无等待队列，繁忙 429 + Retry-After。门限随服务实例执行，不支持多进程共用 runtime。

所有路径服务器构造，拒绝穿越/软链接；文件名限制、严格 UTF8/base64、私有原件与原子 record 替换；评分返回后再次 CAS。输出转 CSV 时中和公式前缀，UI 用 textContent。产物写入后 record 更新失败会回滚本次产物；进程意外终止发生在二者之间的恢复尚未验证。

可复验：

```sh
node --test scripts/sower-work-web/cloud-workbench/tests/service.test.mjs
node scripts/sower-work-web/cloud-workbench/tests/load.mjs /absolute/path/load-report.json
```

19 项真实 loopback HTTP + 隔离磁盘测试覆盖全链路、hash、重新构造服务后的持久读取、跨用户/租户/工作区、CAS、注入/路径/大小/软链接、缺失数据、worker 并发/断连/完成竞态及容量失败回滚。身份验证在这批 fixture 中模拟；SaaS broker/CSRF 与真实 UI 验收单列。20 秒超时终止有实现，未用真实模型或长业务任务故意耗尽 20 秒。负载只验证小型导入数据的实际读接口及产物，不代表生产/收费模型/平台业务容量。
