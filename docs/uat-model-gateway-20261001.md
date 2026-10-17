# 模型网关测试版收口记录 · 2026-10-01

验收时间：2026-10-01 22:49（Asia/Shanghai）。代码已在共享工作区完成，网关定向测试和全项目类型检查通过。真实带 Key 的中转连接未验证：本地没有现有可用的上游凭据。未创建付费图片/视频任务，未部署生产。

## 本轮范围与集成边界

本轮只修改 `src/lib/model-gateway/catalog.ts`、`proxy.ts`，`src/components/model-gateway`，`src/app/models/page.tsx`，`src/app/api/model-gateway/overview/route.ts`，并新增网关配置/网络/目录/任务查询模块、管理接口、`src/app/api/v1` 路由与网关测试/本文档。没有修改共享 store、auth、middleware、Prisma schema、管理/注册、充值订单或支付授权实现；工作区中这些文件的并行改动属于其它任务，均保留。没有重置账号、数据库、历史或凭据，没有向其它聊天发消息。

主聊天需要合入访问规则和发布。当前 middleware 只放行旧 `/v1/`，没有放行 `/api/v1/`；因此新端点的 handler 已通过测试，但独立 Bearer Key 客户端直接访问 `/api/v1/` 仍可能先被会话鉴权拦截。请由主聊天在允许的范围内放行准确的网关端点，保持每个 handler 的本站 Key 鉴权；不要公开中转站管理接口。普通页面、受邀访问、充值开通和创意代理门禁仍由主聊天负责。

## 已实现行为

- 管理员可设置中转站 Base URL、替换/保留/显式清除上游 API Key、维护调用别名/上游模型名/显示名称/类型/费率/启用状态。平台管理员按数据库 `user.authRole === "admin" && user.status === "active"` 判断；`user.role` 是租户管理视图角色，不能授权全局中转配置。
- 管理 API 读取只返回 `baseUrl`、`keyConfigured`、`keySource`、模型配置和保存时间；不返回明文 Key。输入框成功保存后清空，无 localStorage/sessionStorage 持久化。普通用户的 overview 和页面只获得公开模型目录，不获得上游地址、上游模型名、凭据或费率配置。
- 未保存新配置时保留原 `MODEL_GATEWAY_SHAOZHUANG_BASE_URL` / `MODEL_GATEWAY_SHAOZHUANG_API_KEY` 回退以及 `chatGPT5.5` / `image2` 默认目录；保留 OpenAI、DeepSeek、通义、豆包、智谱既有直连路由。空 Key 表示保留；`clearKey: true` 明确清除并关闭环境变量 Key 回退。
- Base URL 支持根域自动补 `/v1`、去尾斜杠和保留合法 API 前缀（例如 `/compatible-mode/v1`、`/api/v3`）。只允许 HTTPS 公网目标，拒绝 userinfo、Base URL 的 query/hash、私网/本地/保留地址；每次网络请求检查所有 DNS 答案并固定已检查 IP 连接，TLS 验证原域名，不跟随重定向。
- 连接测试与目录同步仅带 Key 读取已保存上游的 `GET /models`，不创建生成任务；处理缺 Key、认证拒绝、限流、超时、网络失败、非 JSON/畸形/超大目录。同步合并现有条目，保留手动设置与停用状态，直连同名 ID 使用中转别名；未知类型保持停用，须明确类型与费率再开通。联网同步期间配置变化返回 409，避免把旧站目录写入新配置。
- 图片和视频费率使用整数分，聊天费率可按每千 Token 配置。图片/视频请求前检查完整固定费用，聊天检查输入估价；失败调用按 0 分记录。图片返回数量超过请求预算时拒绝成功结算，避免意外超量扣费。
- 聊天、图片 JSON 和图片编辑/视频 multipart 上传保留业务参数，转发时替换为已配置的上游模型名。错误输出脱敏，网络/超时/无效响应返回标准 JSON；上游 401/403 映射为 502，避免客户端误以为本站 Key 无效；429 保留安全的 `Retry-After`。所有网关响应不缓存。
- 视频创建可识别 `request_id`、`id`、`task_id` 及 `data`/`video` 内的标识并返回规范 `id`。任务归属保存在已有 GatewayUsage 成功流水的 `userId` / `requestId` / metadata 中，不新增 schema，不在流水中存凭据。视频查询/内容下载按当前用户查找成功任务，拒绝跨用户和路径穿越。上游受保护内容 URL 重写到本站下载端点。
- 视频按上游成功接受任务时的固定 `videoCents` 收费一次，状态和下载不收费，余额耗尽仍能读取已付费任务。媒体内容流式传输，支持安全 Range/206 和 `variant=video|thumbnail|spritesheet`，只转发媒体/范围头，不转发上游 Cookie。上游 Base URL 更改后旧任务读取返回 409，避免将新凭据发给旧域名。
- 管理 UI 提供保存、只读连接测试、目录同步、逐项类型与费率设置、忙碌态和错误提示。配置损坏时账户页面仍显示钱包/Key/套餐/流水，目录安全降级为空；代理继续失败关闭，服务端损坏配置需管理员在私有文件位置修复。

## 接口清单

| 地址 | 方法 | 鉴权与状态 |
| --- | --- | --- |
| `/v1/chat/completions` | POST | 原有入口，保留；本站 `sk-sz-` Key + 余额 |
| `/v1/images/generations` | POST | 原有入口，保留；本站 `sk-sz-` Key + 余额 |
| `/api/v1/models` | GET | 本站 Key；公开可启用目录，不要求余额；待主聊天放行 |
| `/api/v1/chat/completions` | POST | 同一聊天处理器；待主聊天放行 |
| `/api/v1/images/generations` | POST | 同一生图处理器；待主聊天放行 |
| `/api/v1/images/edits` | POST | JSON 或 multipart；图片模型/本站 Key/余额；待主聊天放行 |
| `/api/v1/videos` | POST | JSON 或 multipart；明确登记视频模型/固定任务费；待主聊天放行 |
| `/api/v1/videos/:id` | GET | 本站 Key + 任务归属；待主聊天放行 |
| `/api/v1/videos/:id/content` | GET | 本站 Key + 任务归属；媒体流；待主聊天放行 |
| `/api/model-gateway/relay` | GET / PUT | 仅 active 平台管理员的登录会话 |
| `/api/model-gateway/relay/test` | POST | 同上；只读测试已保存配置 |
| `/api/model-gateway/relay/sync` | POST | 同上；合并上游目录到服务端配置 |

本轮范围不包含 `src/app/v1` 新路由，所以没有新增 `/v1/models`、`/v1/images/edits` 或 `/v1/videos`。如需要让客户端统一使用 `/v1`，主聊天可增加这些薄别名，调用已有同一处理器。旧两条 `/v1` 路由已通过导入现有处理器继续工作。`stream=true` 仍明确返回 400；本轮未开通流式聊天或图片输出。

请求体上限 32 MiB，JSON 上游响应上限 64 MiB，配置请求上限 1 MB，目录响应上限 2 MB。生成/下载超时默认 120 秒，服务端 `MODEL_GATEWAY_TIMEOUT_MS` 可设置为 1 秒至 300 秒；连接目录测试使用 20 秒。生成超时不表示上游未受理，客户端应避免自动重复提交。

## 服务端持久化与上线配置

无需 schema migration。默认配置文件在仓库外：

```text
~/.config/shaozhuangai/model-gateway/<SHA256(项目绝对路径)前12位>/relay.json
```

目录 `0700`、文件 `0600`，写入临时文件 fsync 后原子 rename。凭据为受文件权限保护的服务端明文配置；没有把服务端 API Key 存入浏览器、public 或 GatewayUsage。部署时请显式设置 `MODEL_GATEWAY_CONFIG_FILE` 到服务端私有的持久卷，例如 `/var/lib/sanjie/model-gateway/relay.json`，并保证 Node 进程有读写权限；不要指向静态公开目录。默认路径随 checkout 改变，生产不能依赖每次发布都保留同一 checkout。多实例应使用同一私有配置存储并协调写入；当前写队列只协调单个 Node 进程，不提供分布式锁。

## 自动化验证（最终运行）

| 验证 | 精确结果 |
| --- | --- |
| 网关代理/配置/管理/目录/任务归属 | 8 文件，119 项通过，2026-10-01 22:49:24，1.07 秒 |
| 网关 UI/表单/页面与 overview | 3 文件，14 项通过，同一时间，957 ms |
| 全项目 TypeScript | `tsc --noEmit --incremental false`，exit 0 |
| 本轮文件差异格式 | `git diff --check`，exit 0 |

合计 133 项网关相关测试通过。UI 使用隔离 JSX 配置运行 SSR 验证，未更改项目全局 Vitest 配置。默认全量测试不收集 `*.ui-test.ts`，主聊天请同时运行下面第二条命令。Vitest 输出的既有 `configLoader: native` 格式提示是警告，没有测试失败。

```sh
npx vitest run \
  src/lib/model-gateway/catalog.test.ts \
  src/lib/model-gateway/proxy.test.ts \
  src/lib/model-gateway/proxy-routes.test.ts \
  src/lib/model-gateway/relay-config.test.ts \
  src/lib/model-gateway/relay-network.test.ts \
  src/lib/model-gateway/runtime-catalog.test.ts \
  src/lib/model-gateway/video-jobs.test.ts \
  src/app/api/model-gateway/relay/route.test.ts

npm exec -- vitest run --config src/components/model-gateway/vitest-ui.config.ts
npm run typecheck -- --incremental false
```

覆盖：原目录/直连保留、端点匹配、Key 缺失和停用、余额不足、JSON/multipart 转发、参数校验、HTML/畸形响应/网络/超时/限流/秘密回显、模型别名、媒体 Range/variant、视频收费/归属/变更地址、配置原子写/权限/清除/合并/竞态、DNS/私网/重定向、authRole 权限、普通用户页面/overview 脱敏、错误降级。测试网络、数据库和生成响应使用模拟数据，没有运行真实生成任务。

## 真实只读验证与能力限制

本地 `.env` 系列、当前进程和默认新配置文件均未发现可用网关上游 Key；默认新配置文件尚不存在。没有猜测或重置凭据。

| 项目 | 状态 |
| --- | --- |
| 中转站公开首页 HTTP | 200，可访问；标题 `Sub2API - AI API Gateway` |
| 有效上游 Key 的连接测试 / `GET /v1/models` | 未执行，缺少现有可用凭据 |
| 实际上游目录同步 | 未执行，缺少现有可用凭据 |
| 真实聊天/图片/视频创建 | 未执行，无生成费用 |
| 真实视频状态/内容下载 | 未执行，无已有可验证任务 |
| 生产访问门禁/页面实机操作/生产部署 | 由主聊天合入后验收 |

[Sub2API 官方上游路由](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/gateway.go) 支持上述视频路由形状，但其视频处理依赖 Grok/Composite 分组；本站实际部署版本和 Key 分组未知。目录里存在模型名称也不证明其某一模态端点可用，所以不按名称猜测类型或默认开通视频。[视频服务源码](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/grok_media.go) 支持 JSON/multipart、多个任务 ID 字段和 `duration` 等参数；本代理保留提交字段，上游专有参数需按实际模型配置填写。

[OpenAI 当前官方视频文档](https://developers.openai.com/api/reference/resources/videos/methods/create) 说明 Sora 2 与 Videos API 已于 2026-09-24 关闭。本轮不默认注册 OpenAI/Sora 直连视频模型，也不宣传其可用；视频能力仅是显式配置的中转兼容路由。更多公开取证见 [只读审计补充](./uat-model-gateway-audit-20261001.md)。

视频任务受理后异步失败暂不自动退款；更换上游 Key 可能导致旧任务不可访问。当前沿用既有钱包/流水交易接口，没有改余额预留或支付授权；聊天输出 Token 与并发调用仍可能超过请求前的余额估价。上游生成成功后本地记账失败不能与上游生成原子回滚，需人工对账。以上不是已完成的真实 UAT 项目，应在测试版对外范围内如实说明。

主聊天发布前需完成：受控放行新兼容路由或增加旧前缀别名、配置私有持久卷与有效上游 Key、运行管理员只读连接/模型同步、核对实际视频分组和模型协议，再验证已授权的真实生成及下载。没有有效 Key 时不得把本记录视作真实生成验收通过。
