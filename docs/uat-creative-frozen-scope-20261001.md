# 冻结 R51 候选专项测试（2026-10-01）

运行目录：`/Users/shaozhuang/20260606sanjie/.codex-deploy/creative-uat-20261001/source`。没有使用根工作区的测试运行结果代替冻结候选验证。编译业务代码未因最后取消提示修复改变；两个静态脚本与对应测试已作精准更新。

## 结果

| 运行 | 文件 | 通过项 | 失败 | 待运行 |
| --- | ---: | ---: | ---: | ---: |
| 主 Vitest 配置 | 33 | 466 | 0 | 0 |
| 独立网关 UI 配置 | 3 | 14 | 0 | 0 |
| 合计 | 36 | 480 | 0 | 0 |

主运行显式选择下列测试文件；网关 UI 使用 `src/components/model-gateway/vitest-ui.config.ts`。运行进程移除 `DATABASE_URL`、`DIRECT_URL`，并设置 `PAYMENT_CORE_INTEGRATION=0`、`REGISTRATION_CORE_INTEGRATION=0`。真实数据库集成测试未纳入选择；没有创建 schema，也没有连接或替换数据库。DB 相关业务由 mocks 验证，不代表真实数据库闭环。

控制台出现 Vite 未来配置加载提示，以及网页 VM fixture 不支持本机图片档案的清理提示；没有失败断言或数据库连接错误。

首版历史冻结包 SHA256：`ad59112b9b741ff3eba03acba089fc63d15f46ff5766dd5df5d9980b5a49a6ab`。取消提示补丁后的新包由根任务重新生成并记录 SHA。

JSON 逐项证据均在包外：

- `/Users/shaozhuang/20260606sanjie/.codex-deploy/creative-uat-20261001/frozen-scope-tests.json`
- `/Users/shaozhuang/20260606sanjie/.codex-deploy/creative-uat-20261001/frozen-scope-ui-tests.json`

## 实际测试文件

### 主配置

- `src/app/api/auth/me/route.test.ts`：10 项通过。
- `src/app/api/auth/register/route.test.ts`：30 项通过。
- `src/app/api/creative/proxy/route.test.ts`：4 项通过。
- `src/app/api/invite-codes/[id]/route.test.ts`：11 项通过。
- `src/app/api/invite-codes/route.test.ts`：34 项通过。
- `src/app/api/managed-users/[id]/reset-password/route.test.ts`：13 项通过。
- `src/app/api/managed-users/[id]/route.test.ts`：26 项通过。
- `src/app/api/managed-users/route.test.ts`：4 项通过。
- `src/app/api/model-gateway/orders/[id]/mark-paid/route.test.ts`：6 项通过。
- `src/app/api/model-gateway/orders/[id]/route.test.ts`：5 项通过。
- `src/app/api/model-gateway/orders/route.test.ts`：6 项通过。
- `src/app/api/model-gateway/relay/route.test.ts`：8 项通过。
- `src/app/login/page.test.ts`：8 项通过。
- `src/components/management/ManagementConsole.test.ts`：17 项通过。
- `src/lib/accounts.test.ts`：51 项通过。
- `src/lib/auth-redirect-url.test.ts`：19 项通过。
- `src/lib/auth.test.ts`：11 项通过。
- `src/lib/creative-access-policy.test.ts`：6 项通过。
- `src/lib/creative-proxy.test.ts`：6 项通过。
- `src/lib/creative-web.test.ts`：10 项通过。
- `src/lib/model-gateway/catalog.test.ts`：2 项通过。
- `src/lib/model-gateway/payment.test.ts`：5 项通过。
- `src/lib/model-gateway/proxy-routes.test.ts`：49 项通过。
- `src/lib/model-gateway/proxy.test.ts`：2 项通过。
- `src/lib/model-gateway/relay-config.test.ts`：13 项通过。
- `src/lib/model-gateway/relay-network.test.ts`：35 项通过。
- `src/lib/model-gateway/runtime-catalog.test.ts`：3 项通过。
- `src/lib/model-gateway/video-jobs.test.ts`：7 项通过。
- `src/lib/route-guards.test.ts`：3 项通过。
- `src/lib/store/user-store.test.ts`：22 项通过。
- `src/lib/tool-entitlements.test.ts`：5 项通过。
- `src/lib/uat-environment.test.ts`：2 项通过。
- `src/middleware.test.ts`：33 项通过。

### 网关 UI

- `src/components/model-gateway/ModelGatewayConsole.ui-test.ts`：3 项通过。
- `src/components/model-gateway/ModelGatewayPage.ui-test.ts`：5 项通过。
- `src/components/model-gateway/relay-form.test.ts`：6 项通过。

## 证据边界

这 480 项只覆盖冻结候选的创意门禁/代理/网页桥接、账号登录与注册、受邀和用户管理、订单付款规则及模型网关。没有真实供应商生成、真实收费、真实中转 Key 连通或用户原浏览器迁移；公网部署状态由主任务的公网验收记录说明。

## 2026-10-02 00:07 取消提示精准补丁复验

仅同步两个静态脚本与 `src/lib/creative-web.test.ts` 至根目录及冻结 source。配置取消返回 `ok:true, opened:true, saved:false, cancelled:true`；视频页面仅显示中性提示“已取消视频 API 配置，未保存修改。”并返回，不设置能力刷新标记。原通用拒绝提示来自将字符串 error 当成对象读取；此补丁只区分正常取消，不更改供应商任务取消或成功保存路径。

新增两个真实 VM 执行实例，覆盖取消按钮和无 returnValue 的关闭：原已配置 Key map 与所有存储值完全不变、没有写入或能力刷新、账号不变、配置按钮 pending 状态释放，没有供应商请求。原 33 文件重新通过 466 项，加网关 UI 3 文件 14 项，合计 36 文件 / 480 项全部通过。两个脚本 `node --check`、测试文件 lint、冻结 source typecheck 均通过。数据库 URL 在测试进程中移除，真实 DB opt-in 仍关闭。

JSON 旧版 478 项证据已保留为 `frozen-scope-tests-v1.json` 与 `frozen-scope-ui-tests-v1.json`；当前未加 v1 后缀的报告记录 480 项。补丁 agent 未修改 TAR 或发布 manifest；根任务随后从旧密封包原文保留 491 文件、替换精准 3 文件重新封包，新 SHA 如上，494 文件逐项通过。旧 TAR 与旧 manifest 保留为 `-v1`，实际服务器精准 CAS 另见部署报告。
