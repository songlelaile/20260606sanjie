# 模型网关只读审计记录（2026-10-01）

本记录由并行审计任务生成，仅新增本文档，未修改源代码、账号、凭据、数据库或生产服务。现有未提交修改均保留。它是 `docs/uat-model-gateway-20261001.md` 的审计补充，不能代替新功能测试结果。

## 已核对的原有实现

- `src/lib/model-gateway/catalog.ts` 原有固定目录包含少壮中转 `chatGPT5.5`、`image2`，及 OpenAI、DeepSeek、通义、豆包、智谱直连模型。中转默认 Base URL 为 `https://sub.shaozhuangai.com/v1`。
- `src/app/v1/chat/completions/route.ts` 和 `src/app/v1/images/generations/route.ts` 直接从 `@/lib/model-gateway/proxy` 导入处理函数，均为 Node.js、动态路由。原实现没有 `/v1/models`、视频及 `/api/v1` 入口。
- 原代理保留 `sk-sz-` 本站 Key 鉴权、禁用 Key/禁用用户检查、余额检查及调用流水。上游 Key 从服务器环境变量读取，不经 overview 返回。原代理不支持流式。
- 旧手动确认付款接口使用 `session.role === "admin"`。最新用户模型的登录角色为 `authRole`，`role` 为业务管理视图角色；新中转管理守卫已核对使用 `user.authRole === "admin" && user.status === "active"`，避免角色混用或禁用管理员继续操作。
- 初始核对时 `src/middleware.ts` 放行 `/v1/`，未放行 `/api/v1/`。直接调用 `/api/v1` 的 Bearer Key 客户端需要主聊天在 middleware 范围内补充受控放行；最终集成状态以主验收记录为准。

## 中转站公开验证

只读 HTTP 访问 `https://sub.shaozhuangai.com/` 返回 200。页面标题为 `Sub2API - AI API Gateway`，公开配置的 `site_name` 为 `Sub2API`，`doc_url`、`api_base_url`、`version` 均为空。公开 JS 资产返回 200，其中法律文档指向 Sub2API 上游项目。因此可确认页面使用 Sub2API 前端，不能把 New API 文档当作此站当前实际协议或能力证明。

查阅 [Sub2API 官方上游网关路由源码](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/gateway.go)，可确认上游 main 注册以下形状：

| 能力 | 上游 main 路由 | 本站可用性 |
| --- | --- | --- |
| 模型目录 | `GET /v1/models` | 未带凭据验证 |
| 聊天 | `POST /v1/chat/completions` | 未付费调用 |
| 图片 | `POST /v1/images/generations` | 未付费调用 |
| 创建视频 | `POST /v1/videos`、`POST /v1/videos/generations` | 未验证部署版本与 Key 分组 |
| 视频状态 | `GET /v1/videos/:request_id` | 未创建任务，未验证 |
| 视频内容 | `GET /v1/videos/:request_id/content` | 未创建任务，未验证 |

上游视频 handler 对非 Grok/Composite 分组返回 404。因此同域下存在 route 形状并不能证明某 Key 或某模型可生成视频。模型同步请求应使用 `/models` 且不添加 `client_version`，因为 Sub2API 会为 Codex 客户端查询返回不同目录格式。

进一步核对 [Sub2API 视频服务源码](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/grok_media.go) 与 [视频 handler](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/grok_media.go)：创建请求可解析 JSON 或 multipart；JSON 常见字段为 `model`、`prompt`、`aspect_ratio`、`resolution`、数值 `duration` 和 `image`/`images`/`reference_images`。multipart 可解析同名文本字段及 `image` 文件。服务按 `request_id`、`id`、`data.request_id`、`data.id`、`video.request_id`、`video.id`、`task_id`、`data.task_id`、`video.task_id` 顺序取任务标识。查询保留上游状态 JSON，但把 `video.url` 和受保护内容地址重写成 Sub2API 本地 `/content`；本站代理宜进一步指向本站内容路由，避免客户用本站 Key 请求受中转 Key 保护的地址。内容响应是带类型、范围和下载头的媒体流，不是 JSON wrapper。上述仍只证明上游 main 的实现，本站部署版本和 Key 分组尚未核验。

[OpenAI 官方视频接口文档](https://developers.openai.com/api/reference/resources/videos/methods/create) 在核对日明确声明 Sora 2 与 Videos API 已于 2026-09-24 关闭，且没有一一对应的替代 API。该页保留的 `POST /videos` 与任务对象仅供历史参考。测试版不应默认宣传 OpenAI/Sora 直连可用，可提供管理员显式配置的中转通用视频路由。

## 凭据与真实连接结果

检查范围仅为项目 `.env` 系列配置文件与当前进程的相关网关变量；未读取其它账户或第三方账户凭据，未打印任何密钥。

| 检查 | 结果 |
| --- | --- |
| `.env` 中 MODEL_GATEWAY / OPENAI_API / RELAY_API / UPSTREAM_API / NEW_API 相关项 | 未发现 |
| `.env.local`、`.env.development*`、`.env.production*` | 文件不存在 |
| 当前进程中上述相关凭据项 | 未发现 |
| 新默认服务端中转配置文件的可用凭据 | 主任务只读确认未配置 |
| 带有效 Key 的 `GET /v1/models` | 跳过，缺少现有可用凭据 |
| 聊天、图片、视频生成 | 未执行，不产生生成费用 |

首页 200 只证明公开站点可访问。连接测试与模型同步的带 Key 验证仍需配置可用中转 API Key 后执行。

## 基线测试

执行命令：

```text
npx vitest run src/lib/model-gateway/catalog.test.ts src/lib/model-gateway/proxy.test.ts
```

结果：2 个测试文件、4 项测试通过（451ms）。覆盖原少壮中转模型注册、既有直连目录保留、跨端点模型拒绝、默认/自定义 Base URL 拼接及缺上游 Key 时失败关闭。这些是原实现的基线测试，不构成新配置/视频功能的完整验收。

## 新实现需要的关键安全与回归覆盖

- 配置管理：匿名 401、非管理员 403；API Key 只在提交时进入服务器，所有读取/overview/错误输出均只返回配置状态；留空 Key 保留已有凭据，清除须明确动作。
- URL 边界：规范化根域与 `/v1/` 尾斜杠；拒绝明文 HTTP、userinfo、query/hash、本地或私网目标；禁用自动重定向，避免携带上游 Key 跳往另一目标。自定义直连 Base URL 应保留 `/compatible-mode/v1`、`/api/v3` 等合法前缀。
- 连接与同步：缺 Key、401/403、429、网络失败、超时、HTML 错误页、畸形 JSON、空目录都返回准确提示；同步成功才覆盖目录；模型 ID 去重、数量和长度上限；模型能力需要管理员明确确认，不能只凭名字把未知模型视为聊天可用。
- 代理：原模型与旧 `/v1` 路由继续可用；新 `/api/v1` 使用同一 `sk-sz-` 鉴权；各类型匹配明确端点；异常不得透传上游凭据；失败调用记为 0 费用；图片返回格式、聊天 usage 和参数透传。
- 视频：仅创建请求计费，状态/内容读取不重复扣费；任务持久化绑定本站 user 和已选上游/模型；其它用户即使知道任务 ID 也不能查询/下载；拒绝 ID 路径穿越；内容保留正确 Content-Type，支持返回 206/Range 时须避免全量缓冲；任务不能因重启失去归属信息。

原有余额仅检查 `balanceCents >= 1`，后续按模型实际调用费扣账，未在请求前预留完整估价。高成本及并发请求可能使余额为负；这是历史计费边界，本审计未改支付/订单或余额实现。主聊天收口应在最终记录中明确该限制。

## 新代理实现模拟验收

审计子任务新增 `src/lib/model-gateway/proxy-routes.test.ts`，对鉴权/余额、配置读取、网络请求、用量记账和视频任务查询使用测试替身。未真实联网、读取凭据、调用数据库或产生费用。

最终执行命令：

```text
npx vitest run src/lib/model-gateway/proxy-routes.test.ts
```

结果：1 个测试文件、49 项测试通过（358ms）。覆盖动态中转 Base URL/API Key/model 覆盖；无效 Key、余额不足、错误类型、流式请求与 n 范围的请求前拒绝；完整图片费用预检查与小数向上取整；multipart 图片编辑/视频透传；视频 task_id/request_id 的归一及一次创建计费；网络异常、499/504、HTML、空输出、401/429 的零费用与秘密脱敏；模型目录只返回公开字段；视频跨用户拒绝、Base URL 改变时 409、状态/下载不扣费、受保护内容 URL 重写；流式媒体下载、Range 206 和 variant；下载不透传 Cookie 或任意上游头。

扩展测试曾发现 429 错误分支丢失 `Retry-After`，主任务已修复，最终 49 项均通过。审查指出的配置同步竞态、超长自动别名和视频费率整数边界由配置实现任务修复；它们的独立测试记录由主验收文档汇总。新代理已对图片/视频完整费用进行请求前检查，聊天的最终用量变化及多个并行请求的后置余额风险仍保留。
