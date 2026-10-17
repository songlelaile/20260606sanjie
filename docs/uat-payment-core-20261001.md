# 2026-10-01 充值订单核心测试版

本次交付为本地可测试的**人工收款确认闭环**。未配置支付宝、微信或 Stripe 等真实支付供应商凭据；没有自动收款回调，也没有把创建订单或点按钮当作到账。此报告不代表线上发布或真实收款验收。

## 已实现

- 下单只接受套餐码，订单金额、额度和用户由服务端确定。非法套餐、异常金额和未实现的支付供应商拒绝下单。
- `MODEL_GATEWAY_AUTO_PAY` 完全不参与订单入账；即使旧环境变量为 `1`，新订单仍为 `pending`。
- 用户以 `GET /api/model-gateway/orders/[id]` 轮询自己的订单；有效管理员可读取订单明细。订单列表和明细带 `Cache-Control: private, no-store`，其它用户看到相同 404。
- `POST /api/model-gateway/orders/[id]/mark-paid` 只允许当前有效管理员，要求会话 `role=admin`、数据库 `authRole=admin`、`status=active`。核心事务还再次查询确认管理员当前权限。
- 人工确认请求必须提供真实收款流水号 `receipt`、整数人民币分 `receivedAmountCents`，以及可选备注 `note`。实收金额必须精确等于订单金额。凭证为 4 至 160 字符，备注最多 500 字符。
- 订单以同一数据库事务先条件更新 `pending → paid`，再充值钱包。确认管理员、凭证、实收金额、备注和到账时间同时落库；钱包失败则订单及凭证一起回滚。
- 同订单同凭证重复确认幂等；其它凭证不得覆盖已确认订单。数据库唯一索引禁止一笔收款凭证给多个订单充值。失败或关闭的订单、非 `manual` 订单不能通过人工接口入账。
- 下单和确认按实际请求字节限制体积。账户或业务数据库异常返回安全 JSON 503，不把数据库异常、连接串或密钥返回给前端。

## 接口示例

管理员先从真实收款渠道核对订单及到账金额，再提交：

```json
{
  "receipt": "真实渠道收款流水号",
  "receivedAmountCents": 9900,
  "note": "已核对订单与到账"
}
```

`confirmedBy` 由服务端取当前管理员 ID，忽略客户端伪造值。人工收款地址可用 `MODEL_GATEWAY_MANUAL_PAY_URL` 配置为无内嵌凭据的 HTTPS URL；未配置地址时必须由运营提供明确收款说明，网站不能宣称自动付款可用。

## 数据迁移与复用测试库

根任务提供迁移 `prisma/migrations/20261001150000_gateway_payment_audit/migration.sql`，为订单增加可空审计字段及凭证唯一索引。应在候选部署流程中先迁移，再启动候选程序；本任务没有在现有业务库或生产库运行迁移。

`scripts/payment-uat-db.mjs` 导出 `createPaymentUatDatabase()`，只允许本机 PostgreSQL，建立唯一 `payment_uat_*` schema，并把 Prisma schema 推入该隔离空间。返回 `{ schemaName, url, cleanup }`；调用方用 `url` 作为测试进程的 `DATABASE_URL`，测试结束 `await cleanup()`。**不要输出 `url`，其中可能包含本地数据库凭据。** 不修改其它 schema 的租户或业务记录。

## 测试记录

```text
npm exec -- vitest run src/lib/model-gateway/payment.test.ts src/app/api/model-gateway/orders
4 files / 22 tests passed

PAYMENT_CORE_INTEGRATION=1 npm exec -- vitest run src/lib/model-gateway/payment-store.integration.test.ts
1 file / 9 tests passed（真实 PostgreSQL 隔离 schema）

npm run typecheck
exit 0
```

纯验证/API 测试覆盖请求校验、用户/管理员权限、订单读取范围、伪造 amount/status/userId/confirmedBy、无效供应商、安全收款 URL、实际字节上限、数据库故障响应和缓存禁止。

真实数据库测试覆盖：旧 AUTO_PAY 无效；24 个并发确认只入账一次；确认凭证及管理员留痕；跨订单重复凭证冲突；金额不符、失败订单、跨用户确认、普通用户自确认均拒绝；钱包写入失败全部回滚；不同凭证抢同订单只允许一笔；相同凭证抢不同订单只允许一笔；审计迁移保留既有订单金额、额度、归属、状态与时间。每次测试自动删除自己创建的 schema。

本报告仅负责订单、付款确认和事务验证。注册→受邀/充值开通→工作台访问的全链路 HTTP/UI 验收由根任务报告补充；真实上游模型调用、自动支付回调、生产收款与线上发布尚未验证。
