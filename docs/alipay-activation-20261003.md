# 支付宝正式启用验收记录

更新时间：2026-10-03（北京时间）。支付宝 `page_pay` 已正式上线。09:00 创建的新订单已真实支付并记账；支付页面因网站会话失效仍停留二维码，本轮已发布页面恢复与自动返回修复，原账号真实页面验收已通过。下方凌晨发布与旧订单记录保留为历史证据，不能作为当前生产版本或当前订单状态。

## 09:00 订单与页面修复

- 本次订单 `cmuroq9xl0009y2byzfeg1dfy`，金额 ¥99，支付时间 `2026-10-03T01:01:47.302Z`（北京时间 09:01:47）。
- 09:19 的独立只读检查确认 `paid`、实收 9900 分、唯一支付宝收据引用、恰好一条该订单充值账本：余额由 0 增加至 `12000 creditCents`（1,200 积分）。钱包与全部账本合计相符，没有补单或财务写操作。此证据不等于支付回调重放测试。
- 页面现场为“未登录”，仍显示付款二维码，到期后显示“二维码已过期”；网站登录与支付宝开放平台登录相互独立，已请求用户在同一网站账号重新登录。
- 修复包含：登录失效隐藏付款入口并保留订单、返回前台立即重查、查询与余额刷新超时恢复、到期后继续检查原订单、余额刷新成功后自动关闭付款窗，以及严格的原订单恢复入口。
- 本次发布基底为 `/opt/sanjie-releases/20261003-gateway-fx-v1`，PM2 152 / 31976，已保留用于回退。本次仅四个界面与测试文件覆盖，保留已上线汇率功能、财务代码、schema、依赖和配置。
- 生产候选 43 条交互测试、类型检查通过；根目录最小合并保留其他工作，初始 40 条对应测试通过；后续并发套餐 UI 改版保留本修复，最终只读复核及 41 条测试通过；服务器 47 项发布保护检查通过。首个候选的服务器测试、类型检查、构建均通过，但启动前连接余量 19 低于要求的 20，发布器拒绝启动及切流。随后精确核验并可逆停用无路由、无依赖、连接均空闲的旧实例 149、150，释放 8 个连接；所有非目标进程和定义保留。新 v2 候选再次通过服务器测试、类型检查、构建及回环健康检查，启动前普通连接余量 27，通过最低 20 的门槛。
- UI 修复已发布为 `/opt/sanjie-releases/20261003-payment-ui-recovery-v2`，端口 31978；新 Nginx 语法检查、切流和公开路径检查通过，发布回执位于该版本 `deployment-logs/payment-ui-recovery-20261003-v2/publication-receipt.json`。没有迁移、安装依赖、更改密钥或财务写入。
- 正式发布于北京时间 10:04:41，PM2 153 / PID 1735266，27 项公开路径检查通过。另从实际 models build manifest 取出 5 个 JS，正式 HTTPS GET 均为 200 且 SHA 与封存构建一致，实际模型页 chunk 包含 3 条新支付恢复文案。证据 `/var/lib/sanjie-payment-ui-20261003-33ff1a92/public-ui-evidence.json`。
- 后续真实页面验收通过：重新导航发现原网站会话有效，先前保留的是旧登录页面。恢复原已付订单后自动关闭窗口、清理恢复 URL，页面显示“支付成功，套餐与积分已到账。”且余额仍为 1,200，未重复入账。截图 `.codex-deploy/wechat-flow-20261003/alipay-auto-return-confirmed.png`。恢复入口为 `https://shaozhuangai.com/models?recharge=1&orderId=cmuroq9xl0009y2byzfeg1dfy`。
- 当前状态与证据：`.codex-deploy/alipay-paid-return-20261003/status.json`，到账截图 `ledger-paid-once.png`；服务器只读账本快照 `/var/lib/sanjie-alipay-order-20261003-cmuroq9xl-ledger-v4/snapshot.json`。

## 商户与权限

- 上海少壮科技中心，应用“三阶引擎”，APPID `2021007104626526`，收款 PID `2088980219918461`。
- 用户重新扫码登录后，支付宝官方页面显示应用“已上线”，电脑网站支付包含 `alipay.trade.page.pay` 和 `alipay.trade.query`。未启用当面付。
- 服务端材料重新核对权限和 SHA；一次只读查询随机不存在订单返回 `ACQ.TRADE_NOT_EXIST`，支付宝应答签名实际验证成功。该检查没有创建订单或转移资金。

## 凌晨正式发布历史

- 仅部署基于 v1 的七个支付相关文件；没有整体部署本地工作区，没有执行数据库迁移或安装依赖。
- 正式版本：`/opt/sanjie-releases/20261003-alipay-page-pay-v3`；PM2 `149` / PID `1672952` / 端口 `31964`。
- 保留原 v1：PM2 `147` / PID `1653833` / 端口 `31960`，可回退。旧 v2 `148` 仍停止。
- 仅新候选加载支付宝材料，保留有效微信及其他应用配置；候选数据库连接池为 `5`。启动前单连接只读探针测得普通可用连接 `29`（含探针，最低门槛 `20`），探针随后断开。
- 支付相关测试、TypeScript、生产构建通过；发布保护 37 项、旧实例回收保护 25 项、临时路由保护 12 项、只读订单验收 16 项在服务器通过。
- 正式发布回执时间 `2026-10-02T18:06:23.159587+00:00`，27 项公开路径检查通过。原登录浏览器另行确认“西西礼”、余额 0、历史记录及支付宝/微信双渠道均正常。
- 临时 canary 已退出并移除后才切换正式流量。首次临时路由因 Nginx map 桶容量不足自动恢复；缩短独立随机标识后，现网语法检查和真实浏览器验证通过。

发布回执在服务器：

`/opt/sanjie-releases/20261003-alipay-page-pay-v3/deployment-logs/alipay-page-pay-20261003-v3/publication-receipt.json`

回执 SHA256：`f28e66ceec17b0bd4a7d1da655dbff97add718f536f3da7c3f591cf4d0c552b1`。

正式 Nginx SHA256：`4c1644022e02305db338261beec1baa097324209fa185a66a854c6947bd2fedf`。

## 数据库连接回收

逐项验证进程身份、Nginx/服务环境/定时任务引用、监听与在途连接、数据库连接归属及空闲状态后，仅停止历史 PM2 `115`、`116`、`121`、`122`、`123`、`124`、`125`、`126`，释放这八个实例持有的 22 个空闲连接。没有删除进程定义或发布目录。

保留视频、UAT、Sower 网页与其内部授权服务、最近回退版本及当前正式站。回收工具保存了私密定义、原 dump 和操作状态；不得整份恢复 dump 覆盖其他进程变化。

运维目录为 `/var/lib/sanjie-payment-maintenance-20261003-a73c09e2`（root / 0700）。发现历史 `/root` 所有者与严格运维假设不同后，另建安全目录处理，没有改动 `/root` 权限。

本轮没有再次执行任何积分清零。

## 凌晨旧订单留存（非本次付款订单）

- 订单号：`cmur9z57e0002zffwwaciqfy4`。
- 正式站 UI 创建时间：`2026-10-02T18:07:03.194Z`。
- 应付：`9900 amountCents`，即 ¥99；应到账 `12000 creditCents`，即 1,200 积分。
- 官方 `excashier.alipay.com` iframe 已实际显示支付宝二维码。
- 只读基线确认：订单 `pending`、未有付款时间/收据/实收金额，钱包 `balanceCents=0`。
- 基线文件：`/var/lib/sanjie-alipay-order-20261003-cmur9z57e/baseline.json`，目录 0700、文件 0600。
- 已将真实手机付款交给用户，尚未获得支付完成确认。

以下命令仅为凌晨操作历史：149 已因无路由及连接空闲而停用，不能再以其旧 PID 执行。旧流程为用户付款后，用已封存只读工具执行 `after`，验证订单 paid、实收金额、收据唯一性与余额增量；再次 UI 查询后执行 `recheck`，观察余额是否不再增加。工具不调用支付服务，不修改业务数据库。

```sh
python3 /var/lib/sanjie-payment-maintenance-20261003-a73c09e2/inspect-alipay-order.py after --order-id cmur9z57e0002zffwwaciqfy4 --expected-pid 1672952 --operation-dir /var/lib/sanjie-alipay-order-20261003-cmur9z57e
python3 /var/lib/sanjie-payment-maintenance-20261003-a73c09e2/inspect-alipay-order.py recheck --order-id cmur9z57e0002zffwwaciqfy4 --expected-pid 1672952 --operation-dir /var/lib/sanjie-alipay-order-20261003-cmur9z57e
```

v1 没有逐笔积分 ledger；因此余额增量和重复查询观察只能说明这次验收结果，不能宣称已有独立账本证明所有场景的恰好一次入账。已有订单条件更新和事务幂等测试属于代码证据。

本地进度与截图在 `.codex-deploy/alipay-activation-20261003/status.json` 及同目录，均不含私钥、DSN 或登录 cookie。
