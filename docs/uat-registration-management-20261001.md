# 注册与管理收口验收（2026-10-01）

本轮为 shaozhuangai.com 作图 / 视频测试版完善手机号自主注册、邀请注册和管理端账号管理。只改注册 / 管理相关实现、测试和本说明；共享目录中的原有修改予以保留。没有部署生产、重置数据库、修改 User schema、迁移旧账号或改动 DMP 授权规则。

核心代码已冻结并通过类型检查，可供主聊天叠入独立网站测试包。后续仅补测试与本文档；线上发布与真实 HTTP 联调由主聊天负责。

## 已实现行为

| 场景 | 最终行为 |
| --- | --- |
| 无邀请码自主注册 | 创建独立 Tenant、User、默认 Shop 和空白 ShopCalcRun；写注册来源，不授受邀工作台权限；登录后按主聊天充值规则开通 |
| 邀请码注册 | 每位客户仍创建独立租户；消耗次数、账号 / 店铺 / 注册来源 / 受邀授权处于同一事务 |
| 自主注册文案 | 明确“建立独立工作区，非受邀客户须充值开通作图与视频”；不承诺免费直接可用 |
| 管理用户列表 | 分别展示工作区 ID、注册来源、账号状态、实际作图 / 视频访问状态、受邀工作台权限和 DMP 授权 |
| 已充值客户 | 使用主聊天 `resolveCreativeAccess` 策略及最近有效 paidAt，显示充值访问状态和到期时间；充值不改变注册来源 |
| 历史来源缺失 | 显示“旧账号待核对”，不根据手机号、店铺名、创建时间或 DMP 授权猜测是否受邀 |
| 人工确认受邀 | 管理员明确确认后调用主聊天 creative-access 接口；随后重新读取管理列表；原注册来源保留 |
| 启用 / 停用 | 只更新账号 status，保留工作区、配置、历史和已有授权；停用账号不能通过现有有效账号校验 |
| 重置密码 | 仅更新 password，保存 scrypt 哈希；10 位随机临时密码只在本次无缓存响应返回；复制失败仍可手动复制，不谎称已复制 |
| 平台管理员 | 使用 authRole 识别管理员；拒绝停用、重置或删除当前管理员及其他平台管理员，租户 owner 不被误认成平台管理员 |
| 用户删除入口 | 管理页面移除永久删除入口；原 DELETE API 为兼容保留，本轮没有调用真实账号删除 |
| 邀请码生命周期 | 生成、剩余次数、可用 / 用尽、复制注册链接、撤销；撤销沿用已有删除实现，仅阻止后续注册，不改变已注册来源或授权 |
| 管理请求失败 | 显示错误并恢复操作按钮；同步操作锁避免双击重复提交；授权变更与账号状态变更后刷新实际访问状态 |

## 已确定的集成契约

采用主聊天明确给出的既有 ToolEntitlement 存储方案，无需新增 User 字段：

- `toolCode=registration_source`、`status=active`、`note=self`：自主注册；`grantedBy=self`。
- `toolCode=registration_source`、`status=active`、`note=invite:<inviteId>`：邀请注册；`grantedBy` 为邀请码创建人，空值回落 `invite`。
- 邀请注册同事务写 `toolCode=creative_studio`、`status=active`、`expiresAt=null`、`note=invite:<inviteId>`。自主注册不写该授权。
- 现有 DMP toolCode 及授权窗口保持原样，注册不创建或更新 DMP 授权。
- 注册来源无记录、状态异常或 note 格式异常一律返回 `legacy`，不补写历史数据。

`src/lib/store/user-store.ts` 提供管理功能；runtime-store 原同名函数仅重导出，保留其他模块兼容。管理读取不为操作用户初始化或改写任何店铺业务状态。管理接口返回来源扩展：`authRole`、`registrationSource`、`inviteCodeId`、`registeredBy`、`registrationSourceRecordedAt`、`creativeStudioAccess`、`creativeAccess`。

`creativeStudioAccess` 表示受邀授权记录；`creativeAccess` 表示主策略解析出的实际访问权限（管理员 / 受邀 / 充值 / 已过期 / 未开通 / 账号失效）。二者不得混用。UI 授权操作调用 `/api/managed-users/[id]/creative-access` PATCH `{enabled:boolean}`，消费 `data.creativeAccess` 后 GET `/api/managed-users`，并链接 `/management/payments` 付款核对页。付款确认、订单和创意访问拦截由主聊天负责。

## 输入、重复与并发保护

- 注册请求体实际读取上限 16 KiB；超限 413。拒绝无效 JSON、数组、错误字段类型、非法大陆 11 位手机号、短密码、超长密码 / 名称、控制字符和非法邀请码。
- 密码规范化规则继续兼容旧登录；注册密码 6–128 字符，姓名 50 字符，邀请码 6–32 位字母或数字。登录和历史明文密码升级逻辑保持原样。
- 重复手机号先校验再由数据库唯一键兜底。只把 username 的 P2002 视为重复手机号；事务外映射使孤立租户及邀请码消耗回滚；其他唯一键错误不能伪装成“已注册”。P2034 重跑完整事务，最多重试两次。
- 邀请码消耗 UPDATE 同时约束 id、code、maxUses 和剩余 usedCount，处理末次竞争及撤销竞争。
- 邀请码生成使用 node:crypto 随机源，唯一 code 冲突重试；次数限定数值类型整数 1–99，说明最多 200 字；非法 ID、额外状态字段和错误类型拒绝。
- 管理接口先做有效管理员校验，所有成功、输入错误及权限错误使用 `Cache-Control: private, no-store`。Store 再验证当前账号与租户 / authRole，避免只信任签名中的旧角色。
- 非管理员管理列表读取限定自身 tenantId；邀请码查询和撤销限定当前管理员 tenantId。管理员用户管理允许跨租户，但目标更新 / 删除仍带原 tenantId、username 和非 admin 条件，目标并发变更返回 409。

## 自动验证

最终范围验证：13 个文件，238 项通过，包含真实 PostgreSQL 的 8 项；UI SSR / 操作验证 25 项通过。`npm run typecheck` 与 `git diff --check` 均通过。

执行命令：

```sh
REGISTRATION_MANAGEMENT_INTEGRATION=1 npm test -- src/lib/store/user-store.test.ts src/lib/store/registration-management.integration.test.ts src/lib/accounts.test.ts src/app/api/auth/register/route.test.ts src/app/api/managed-users src/app/api/invite-codes src/lib/auth.test.ts src/lib/route-guards.test.ts src/components/management/ManagementConsole.test.ts src/app/login/page.test.ts
npm run typecheck
git diff --check
```

单元测试覆盖注册字段和请求体边界、重复与竞争、事务错误回滚模拟、来源与授权区分、保留旧账号 / DMP、管理员保护、租户查询隔离、邀请码生命周期、临时密码响应与 no-store，以及主聊天支付访问策略在管理列表中的展示。

真实 PostgreSQL 测试已以 opt-in 的临时隔离 schema 完成，8 项通过；复用主聊天安全 UAT helper，仅接受本机 PostgreSQL，afterAll 已清理新建 namespace，不操作原有业务 schema 或行。实测包含 12 个同手机号并发仅创建 1 个账号 / 租户 / 店铺、12 个末次邀请码并发仅 1 个成功、邀请码撤销竞争、真实数据库约束拒绝 creative 授权后的完整回滚、独立空白数据与来源、租户隔离，以及启停 / 重置 / 撤销时旧 DMP、配置、历史保留。

## 主聊天需核对的共享范围

2026-10-01 22:52 的全仓 `npm test` 已通过：99 个文件通过，2 个数据库 opt-in 文件默认跳过；970 项通过，17 项默认跳过。注册管理的 8 项真实数据库测试已通过上方 opt-in 命令单独执行。此前并行网关范围的 Retry-After 与 JSX 测试问题在本次全仓回归中已消失，本轮未修改网关范围。

联调读取主聊天 creative-access 路由时还发现两点：当前目标用户查询仅按 id，没有服务端 authRole / 当前管理员目标保护（管理 UI 已隐藏管理员按钮）；兼容字段 `creativeStudioAccess` 当前调用 DMP resolver，对 `expiresAt=null` 的有效受邀授权会返回 expired。当前管理 UI 不依赖该兼容字段，刷新列表后使用本模块独立的受邀授权解析，实际展示正确；建议主聊天修正接口目标保护和兼容字段语义。撤销受邀权限后实际访问状态可能仍为有效充值，须重新用支付策略解析，不能仅凭撤销状态报告“必须充值”。

主聊天收口复验：上述两处接口问题已修复并纳入冻结包。接口保护当前管理员及其他平台管理员目标，永久受邀兼容字段按 `expiresAt=null` 正确返回有效状态；撤销免费邀请后重新读取付款策略，保留有效的充值访问。独立本机服务的 3 项真实 HTTP 联调通过。全仓最终发布门禁更新为 100 个测试文件、977 项通过，另 17 项数据库测试分别执行通过；详情见 `creative-uat-20261001-收口.md`。

重置密码沿用现有会话模型：原密码立即不能再登录，但没有凭密码版本批量撤销已签发会话。本轮未新增会话 schema 或改动 middleware / auth/me；主聊天如要求重置即踢出全部会话，应另行确定契约。

## 发布后人工验收

在主聊天授权并完成发布后，使用专用测试手机号检查：自主注册进入独立工作区并显示充值入口；邀请注册可访问作图 / 视频；旧账号显示来源待核对；管理员确认受邀、撤销、启停和重置密码；原店铺历史、配置与 DMP 授权保持一致；付款核对后 30 天访问状态正确。此处人工线上链路本轮未执行，也未创建生产测试账号。
