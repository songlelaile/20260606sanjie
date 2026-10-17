# 扫码支付密钥配置与积分入账

**2026-10-03 最新实测：** 支付宝 ¥99 订单已真实付款、唯一入账，原账号原订单自动关闭弹窗与返回已通过。最新记录见 [支付宝正式启用验收记录](alipay-activation-20261003.md)。微信当前失败原因已确定，见下节；其余 2026-10-02 内容保留为历史记录。

## 2026-10-03 微信 Native 实测与待处理绑定

- 当前核验版本：`payment-ui-recovery-v2`，PM2 153 / PID 1735266 / 31978。网站当前账号登录有效，店铺西西礼，实测前余额为 1,200 积分。
- 真实 UI 单次创建体验版微信订单 `cmurrkuw300088csczbjjwaqe`（¥99 / 1,200 积分），创建于 `2026-10-03T02:19:49.731Z`。界面返回“支付信息校验失败”，数据库订单 pending、二维码地址为空。
- 对同一明确订单的一次官方签名 GET 返回 `404 ORDER_NOT_EXIST`，微信应答签名、公钥 ID、时效核验全部通过，确认微信侧尚未创建该单。
- 在该可信查询及未到期、同用户、金额和套餐校验后，仅对同单执行一次 Native 诊断 POST。微信返回 **`400 APPID_MCHID_NOT_MATCH`**，应答签名同样真实验证成功。这确定当前生产 AppID `wx38ac0e6ba7af8b0b` 与商户号 `1751269820` 的关系不被微信接受；不是从通用前端文案猜测根因。[官方 Native 错误码](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)
- 未生成二维码、未代付、未写钱包或积分账本；本轮没有更改生产代码、配置或密钥。122 项相关离线测试通过，不能替代真实收款验收。
- 待管理员核对 AppID 归属：若确属三阶引擎，在商户平台「产品中心 → APPID授权管理」发起关联，并由对应 AppID 管理方在公众平台/开放平台完成确认；若实际使用其他 AppID，应提供正确标识后再核对配置。[官方账号关联指引](https://pay.wechatpay.cn/doc/v3/merchant/4013289251)
- 浏览器工具明确阻止访问 `https://pay.weixin.qq.com`（site-safety policy），未尝试绕过，因此商户后台核对交给用户。确认后仍需验收 Native 二维码、用户手机付款、服务器支付核验与唯一入账、页面自动返回；目前不能称微信流程已跑通。
- 脱敏诊断回执保存在服务器 `/var/lib/sanjie-payment-ui-20261003-33ff1a92/wechat-order-cmurrku/`。本地状态与截图位于 `.codex-deploy/wechat-flow-20261003/`。


核对日期：2026-10-02。本文结合主任务的商户页面现场核验、本地代码和官方公开文档更新。此前支付宝记录为电脑网站支付产品已开通、接口加签已设置、本地配置检查全部就绪，应用审核中；`page_pay` 两次发布尝试均已回退，待解决数据库连接容量。本次微信证书 ZIP 已补齐配套私钥，完整配置检查及只读查单应答验签通过，微信配置已在生产 v1 激活并持久化验证。原登录页面与渠道读取成功；首次 Native 生成二维码失败，未付款、未入账，原因诊断中。此次没有重新确认支付宝审批或 v2 数据库容量恢复。

## 当前已确认状态

| 项目 | 现场确认或本地交付状态 |
| --- | --- |
| 企业支付宝应用 | APPID `2021007104626526`；收款 PID `2088980219918461` |
| 应用资料 | 名称已保存为“三阶引擎”，应用 URL 为 `https://shaozhuangai.com` |
| 产品权限 | 电脑网站支付已开通；当面付未开通 |
| 应用状态 | “三阶引擎”已正式提交审核，真实页面显示“审核中，平台将在1天内完成审核”；这是平台提示，不等于已获批，付款启用仍等待审批 |
| 管理员操作 | 应用公钥已上传成功，真实页面显示接口加签“已设置”；已核对平台登记的应用公钥与本机草稿配套 |
| 本机私密材料 | JSON 已保存上述 APPID、PID 和 `ALIPAY_PAYMENT_PRODUCT=page_pay`；支付宝平台公钥已安全保存到本机受保护目录，本地服务端配置检查全部 ready |
| 支付宝服务器私密材料 | 已暂存到权限为 `0700` 的受保护目录，配置文件权限为 `0600`，SHA 已核对；支付宝配置未注入运行进程 |
| 候选实现与发布尝试 | 7 个文件的 `page_pay` 后端、iframe 界面及测试已通过本地和服务器测试、构建；两次仅代码切流后，真实登录 `/models` 均失败，均已回退 v1，待解决连接容量 |
| 数据库连接限制 | 候选实际 DSN 的 `connection_limit=2` 已生效，默认 Prisma 客户端的连接池也确认为 2，但可用数据库连接容量仍不足，不能安全上线 |
| 生产 v1 | 微信配置激活后，PM2 id `147`、PID `1653833` 在线，端口 `31960`，持久化读回验证通过；原登录与“西西礼”店铺上下文保留，购买积分页余额为 0，历史记录保留 |
| 浏览器渠道读取 | 原登录会话下，购买积分入口与只读 GET `/api/model-gateway/checkout` 读取成功：微信 `available=true`，支付宝 `available=false`。此前“读取中”和客户端拦截是旧次验收记录；当前渠道就绪不等于真实收款成功 |
| 候选进程 | 仅停止了 PM2 id `148`，并通过受保护的 PM2 保存流程持久化停用状态，保留旧服务 |
| 微信材料 | 用户提供的证书 ZIP 含商户证书、配套私钥和 P12；私钥与原商户证书完全匹配，商户号与证书序列号一致。本机完整配置检查 ready，目录 `0700`、文件 `0600` |
| 微信只读渠道验证 | 对随机不存在订单的一次 GET 返回 HTTP `404 / ORDER_NOT_EXIST`；四个应答签名头齐全、公钥 ID 匹配、时间戳新鲜，原始应答 body 的 RSA 验签实际成功。没有创建订单或转移资金；不代表 Native 权限、APPID 绑定、APIv3 密钥平台一致性或真实到账已验证 |
| 本轮服务器核验 | 合法 ECS Workbench 中完成 v1 微信配置激活，状态 SHA 为 `624c82d55d770019fb1215143df7281e49f038acdc0355227a2466e682a95d0a`；Nginx 未变，v2 id `148` 保持停止 |
| 首次 Native 页面尝试 | UI 选择体验版 `¥99 / 1,200 积分` 后，生成收款码失败并显示“支付信息校验失败”；未显示二维码、未付款、未入账，具体原因诊断中 |

上述 APPID/PID 是账户标识，不是私钥。本文没有包含私钥、APIv3 密钥或平台公钥内容，也没有完成真实收款或积分到账验收。

用户明确要求所有用户购买积分归零，本轮已执行并通过独立数据库查询和真实浏览器验收：

| 归零结果与证据 | 已确认状态 |
| --- | --- |
| 余额 | 54 个钱包全部为 0，实际调整 8 个，共 `896000 balanceCents`，即 89,600 积分 |
| 保留数据 | 26 笔 `paid/manual` 历史购买订单前后 MD5 同为 `357451953a63e8f9d14b347d66604df6`；usage 保持 0；套餐、配额、账号与 API 配置未改 |
| 审计与幂等 | operationId 为 `cc42fec7-7c49-454f-a6e7-89cbfc81e67d`；事务审计 `sanjie_credit_reset_ops.balance_reset_batches` 及逐户快照保留恢复依据，同一操作重跑不会清除新充值 |
| 脚本验证 | `scripts/reset-purchased-credits.mjs` SHA256：`3e241678ae655fce666a203ba8d8386ccea938957357b18cb6a6cb0fe0b9c720`；4 项隔离 PostgreSQL 测试及独立复跑通过 |
| 线上凭证 | 服务器 `/root/sanjie-credit-reset-20261002-cc42fec7/` 下的 `dry-run.json`、`applied.json`、`verified.json`；本地截图 `.codex-deploy/credit-reset-20261002/production-zero-credits.jpg` |

独立候选基于当前生产 v1，只变更 7 个支付适配/弹窗/测试文件；后端与 API 测试 86 项、弹窗测试 14 项、隔离 PostgreSQL 测试 13 项通过，TypeScript 与构建通过。嵌套候选触发的祖先 ESLint 配置冲突已通过显式隔离配置检查，6 个 TS/TSX 文件零 lint 警告，CSS 解析通过。配置材料工具的 19 项测试通过。候选也完成了服务器测试与构建，但两次发布尝试已回退；这些验证不代表真实登录页面、商户收银台或真实付款已验收。

回退后的只读数据库统计为：`max_connections=100`、超级用户保留连接数 `3`、客户端连接 `97`（含临时探针 `1`），其中 `idle=96`、`active=1`。探针已断开，当时普通连接余量仅约 `1` 个。限制候选连接池为 `2` 仍不足以解决整体容量问题；在容量问题解决并重新验收前，不应再次启用候选。上述为本次现场快照，不代表未来持续状态。

## 先确认商户使用的模式

| 渠道 | 当前代码支持 | 需要商户确认的状态 |
| --- | --- | --- |
| 支付宝 | 自有商户应用、RSA2 普通公钥模式；本次选择 `page_pay`，在 iframe 中加载 `alipay.trade.page.pay` 官方收银台 | 加签与对应支付宝公钥已就绪；等待应用审核通过，再确认正式接口可用 |
| 微信 | 普通商户 Native API v3，商户 API 证书私钥签名，微信支付公钥验签 | 仍需确认 Native 权限、APPID 与商户号双向绑定，以及支付公钥模式/迁移灰度状态 |

本商户应使用已开通的电脑网站支付。`alipay.trade.page.pay` 使用产品码 `FAST_INSTANT_TRADE_PAY`；`alipay.trade.precreate` 对应 `FACE_TO_FACE_PAYMENT`（当面付），不能用电脑网站支付的权限替代。这里不通过开通线下当面付来处理线上 SaaS 收款。[电脑网站支付接口列表](https://developer.alibaba.com/docs/doc.htm?articleId=105900&docType=1&treeId=270)、[支付宝官方预创建参数模型](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePrecreateModel.java)

新实现使用 `qr_pay_mode="4"`、`qrcode_width=220`，在弹窗内展示支付宝托管页面；备用入口使用模式 `2` 打开收银台。官方接口提供页面表单或签名页面链接，不提供此流程的纯 `qr_code` URL，不能把页面链接当作二维码内容自行画码。生成签名链接不代表支付宝远端订单已创建，也不代表付款成功。[官方页面参数](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePagePayModel.java)、[官方页面响应说明](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/response/AlipayTradePagePayResponse.java)

支付宝官方同时提供普通公钥和公钥证书模式，并推荐证书模式；本次实现仅支持前者。如果管理员选择了证书模式，需要另行适配证书材料，不能将证书直接填进当前公钥变量。[支付宝官方 SDK 的平台配置说明](https://github.com/alipay/alipay-sdk-nodejs-all#平台配置)

微信从旧平台证书切换到支付公钥，影响同一商户号下的所有项目；约 7 天灰度期间，回调可能使用任一种签名。本次实现只验证指定的 `PUB_KEY_ID_…`，不能直接用于混合回调阶段。先确认所有相关系统兼容，再由商户决定迁移安排；不要仅为本项目直接点击“开始更换”或“确认切换”。[微信支付公钥官方常见问题](https://pay.wechatpay.cn/doc/v3/merchant/4013038816)

## 支付宝：由账户管理员准备

1. 在支付宝开放平台选择“三阶引擎”，核对上述 APPID、收款 PID 和电脑网站支付权限。当前代码不是服务商代其他商户收款模式，不使用 `app_auth_token`。
2. 管理员扫码验证、**应用公钥**提交已完成，平台登记公钥已与本机材料核对。应用公钥的输入及确认由用户完成；助手不代填新认证密钥。不要上传或粘贴应用私钥，也不要覆盖其他应用已有的密钥。
3. **支付宝公钥**已从同一应用取得并保存到受保护文件，用于服务器验签；它与“应用公钥”是两个不同材料。应用已提交审核，接下来等待审批通过并核验正式接口权限。[接口加签设置指引](https://opendocs.alipay.com/common/02kf5p)、[密钥工具说明](https://opendocs.alipay.com/common/02kipk)

| 服务端变量 | 对应材料 |
| --- | --- |
| `ALIPAY_APP_ID` | 已确认 `2021007104626526`；仍需完成该应用的上线流程 |
| `ALIPAY_SELLER_ID` | 已确认收款 PID `2088980219918461`；用于回调收款方校验 |
| `ALIPAY_PAYMENT_PRODUCT` | 本账户必须显式设为 `page_pay`；若遗漏，兼容默认值仍为 `precreate`，不适用于当前权限 |
| `ALIPAY_PRIVATE_KEY` | 与平台已登记应用公钥配套的 RSA 私钥 PEM，至少 2048 位；PKCS#1 或 PKCS#8 |
| `ALIPAY_PUBLIC_KEY` | 该应用配置中的支付宝 RSA 公钥 PEM，至少 2048 位；不要填应用公钥 |

这些变量均由服务端读取。密钥变量接收 PEM 内容，不是文件路径；支持实际换行或字面量 `\n`。由部署工具从受保护材料注入即可，无需把材料粘贴到聊天或提交进 Git。

## 微信：由超级管理员或安全联系人准备

1. 确认商户已完成入驻并取得 Native 权限，已绑定可用 APPID，且公众平台/开放平台一侧也完成确认。官方列出的可用类型包括服务号、政府或媒体公众号、小程序、移动应用；未认证账号无法绑定。[Native 开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015614538)
2. 在“账户中心 → 商户信息”确认商户号；从已有 APPID 绑定记录取得 APPID。在“账户中心 → API 安全”的商户 API 证书区域，确认在用证书及其序列号；私钥来自相应证书下载包中的 `apiclient_key.pem`。证书私钥与序列号必须配套，优先取已有安全备份。[开发必要参数说明](https://pay.wechatpay.cn/doc/v3/merchant/4013070756)
3. 在“账户中心 → API 安全 → 微信支付公钥 → 管理公钥”下载微信支付公钥 PEM，并记录以 `PUB_KEY_ID_` 开头的完整 ID；同时核实前述模式/灰度状态。[微信支付公钥验签指引](https://pay.wechatpay.cn/doc/v3/merchant/4013053249)
4. APIv3 密钥由“账户中心 → API 安全 → 解密回调 → APIv3 密钥”管理。首次设置由管理员手动完成，要求 32 个数字/大小写字母字符。已设置的密钥不能再次查看，应从原保管位置取得；直接重设会影响使用该商户号的其他 APIv3 系统，须统筹更新。[配置 APIv3 密钥](https://pay.wechatpay.cn/doc/v3/merchant/4012072195)

| 服务端变量 | 对应材料 |
| --- | --- |
| `WECHAT_PAY_APP_ID` | 已绑定的 APPID |
| `WECHAT_PAY_MCH_ID` | 普通商户号 |
| `WECHAT_PAY_PRIVATE_KEY` | 商户 API 证书私钥 PEM，即配套的 `apiclient_key.pem` 内容 |
| `WECHAT_PAY_SERIAL_NO` | 上述商户 API 证书的序列号；不是微信支付公钥 ID |
| `WECHAT_PAY_API_V3_KEY` | 商户自行保管的 32 字符 APIv3 密钥；不是 APIv2 密钥 |
| `WECHAT_PAY_PUBLIC_KEY` | 微信支付公钥 PEM；不是商户 API 证书，也不是旧微信平台证书 |
| `WECHAT_PAY_PUBLIC_KEY_ID` | 上述公钥的完整 `PUB_KEY_ID_…` ID |

微信支付公钥用于验证微信的签名；商户私钥用于签署商户的请求，二者本来就不是一对密钥。商户 API 证书申请、密钥设置、模式切换及其安全验证由账户管理员操作，本轮不代办。

## 付款回调由服务端自动填写

服务端设置 `SCAN_PAYMENT_NOTIFY_BASE_URL=https://shaozhuangai.com`，每笔下单自动传入：

| 渠道 | `notify_url` |
| --- | --- |
| 支付宝 | `https://shaozhuangai.com/api/payments/alipay/notify` |
| 微信 | `https://shaozhuangai.com/api/payments/wechat/notify` |

这里是付款结果的服务端通知地址，支付宝由服务器生成的签名页面请求自动携带，无需将它改填到“应用网关”“授权回调”或页面跳转地址中。付款成功必须以验签后的通知或主动查单为准。[支付宝电脑网站支付接入流程](https://developer.alibaba.com/docs/doc.htm?articleId=105899&docType=1&treeId=193)、[微信 Native 下单参数](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)

回调必须可经公网 HTTPS 访问、不要求用户登录；微信不允许回调 URL 带查询参数，并要求 5 秒内响应。本项目在验签、商户/订单/金额校验和事务入账成功后应答；验证不通过不会充值。[微信回调通知要求](https://pay.wechatpay.cn/doc/v3/merchant/4012075420)

## 积分系统与接下来可做的工作

代码中的支付回调和主动查单已经共同调用积分入账事务。订单保存购买时的价款和积分值，只有经渠道签名验证的成功付款且金额一致才入账；唯一付款回执和订单状态更新防止重复充值。现有钱包以 `balanceCents` 保存整数，界面按 `/10` 显示积分，本次没有另建一套余额。

| 当前候选套餐 | 付款金额 | 入账积分 |
| --- | --- | --- |
| 体验版 | ¥99 | 1,200 |
| 增长版 | ¥299 | 3,800 |
| 团队版 | ¥899 | 12,000 |

以上数值来自本次候选 `catalog.ts`，不是支付平台限制；不把付款金额与积分值直接等同。

支付宝加签、公钥材料和本地配置检查已完成，服务器私密配置仅暂存并核对 SHA，尚未注入。此前记录中的待办仍为：应用审批通过；解决数据库连接容量并重新验证真实登录页面；重新发布已测试的 `page_pay` 补充实现；通过受控部署私密注入生产配置；验证可用状态和通知路由；由用户亲自扫码付款并核验积分只增加一次。两次发布尝试均已回退，支付宝付款启用仍待重新确认应用审批和连接容量。配置检查 ready 仅代表材料可解析，不代表应用已获批、候选稳定上线或真实付款成功。

微信材料已补齐：用户提供 `/Users/shaozhuang/cert/1751269820_20261002_cert.zip`，包内含商户证书、`apiclient_key.pem` 和 P12。私钥与原商户证书完全匹配，商户号为 `1751269820`，证书序列号为 `6636F9E1D7C7C24E8BF7C96D982244792246AA04`。此前文件名搜索未找到私钥的缺项，现已由该 ZIP 解决。微信支付公钥为可解析的 RSA2048 公钥，且与商户证书公钥不同；APIv3 密钥已从用户提供的 RTF 转为纯文本，原文件保留，32 位英文数字格式检查通过。本机完整微信配置已生成并检查 ready，私密目录权限为 `0700`、文件为 `0600`。

本轮只读渠道检查于 `2026-10-02T14:53:19.398Z` 对唯一随机不存在订单执行一次 GET，返回 HTTP `404`、`ORDER_NOT_EXIST`。四个应答签名头齐全、应答公钥 ID 与配置匹配、时间戳新鲜，并已对原始 body 执行 RSA 验签且成功，验证了本次商户请求认证和平台应答签名链路；没有创建订单、发起付款或变更余额。安全摘要见 `.codex-deploy/payment-credentials-20261002/wechat-readonly-channel-check.json`。这项检查不使用 APIv3 密钥解密付款通知，不能证明该密钥与平台一致，也不证明 Native 权限、APPID 与商户号绑定、迁移灰度状态或真实积分入账。

微信专用配置上传至 `/root/sanjie-wechat-20261002-89d65f94/wechat-server-config-20261002-zip-verified.json`，大小 `2610` 字节、权限 `0600`、SHA256 `c10ebaee98840263d1c0ba686d2f83b87899141e02fd6d57b668483375b6fdb1`。合法 ECS Workbench 会话中已完成生产 v1 微信配置激活并通过 PM2 持久化读回验证：id `147` / PID `1653833` / `31960` 在线，激活状态 SHA256 为 `624c82d55d770019fb1215143df7281e49f038acdc0355227a2466e682a95d0a`。v2 id `148` 保持停止，Nginx 未变，SHA 仍为 `ea59650979a350b9b11cf85c6d464120b1ee6ab417b5905ff53323efb8ba4911`。

激活后的真实浏览器验收保留原登录、“西西礼”店铺、余额 0 与历史记录；只读 GET `/api/model-gateway/checkout` 成功，微信 `available=true`、支付宝 `available=false`。随后一次 UI 体验版 `¥99 / 1,200 积分` 的 Native 生成操作失败，页面显示通用错误“支付信息校验失败”，没有二维码，未付款、未入账，原因仍在诊断。渠道可用状态仅表示配置可解析；尚未完成 Native 收款、付款通知解密或积分仅入账一次的端到端验收。APIv3 密钥与平台一致性、Native 权限及 APPID 绑定也尚未验证。支付宝审批、v2 历史回退及数据库容量问题不因微信激活或只读检查通过而视为解决。商户网页的站点安全拒绝未绕过，密钥内容未输出。

## 生成待部署材料：本地工具用法

`scripts/build-scan-payment-config.mjs` 根据管理员准备的材料清单读取指定文件，调用只读校验器，再按需生成新的私密配置文件。它不生成或注册商户密钥，不更新环境变量，不重启服务，不调用支付接口，也不注入生产配置。此次应用公钥已在平台登记，本机材料已通过检查；工具检查成功仍不能替代应用审批或生产发布。

材料清单为 JSON，包含 `providers`、`values`、`files`。支付宝配置材料已就绪，微信配套商户私钥现已由证书 ZIP 补齐，完整配置检查 ready；以下支付宝 APPID、PID 和产品模式采用此前现场已确认值。以下示例中的文件路径是占位符，不包含真实密钥内容：

```json
{
  "providers": ["alipay"],
  "values": {
    "SCAN_PAYMENT_NOTIFY_BASE_URL": "https://shaozhuangai.com",
    "ALIPAY_APP_ID": "2021007104626526",
    "ALIPAY_SELLER_ID": "2088980219918461",
    "ALIPAY_PAYMENT_PRODUCT": "page_pay"
  },
  "files": {
    "ALIPAY_PRIVATE_KEY": "/受保护目录/alipay-app-private.pem",
    "ALIPAY_PUBLIC_KEY": "/受保护目录/alipay-platform-public.pem"
  }
}
```

`providers` 只列实际准备的渠道，并仅包含该渠道的变量。`values` 只放上述普通参数，密钥/公钥通过 `files` 的绝对文件路径提供。微信配置按微信材料表映射，保持独立于支付宝配置；只读 API 检查不等于重试或绕过被拒绝的商户网页访问。清单及私钥/APIv3 密钥文件应归当前执行用户所有且权限为 `0600`，输出目录权限为 `0700`；不要放入网站静态目录或代码仓库。

在项目根目录执行，先仅检查、不生成输出：

```sh
node scripts/build-scan-payment-config.mjs --materials /受保护目录/materials.json
```

检查通过后，使用尚不存在的输出文件路径：

```sh
node scripts/build-scan-payment-config.mjs --materials /受保护目录/materials.json --output /受保护目录/scan-payment-config.json
```

命令只输出安全检查摘要；未配置、格式不正确或输出路径不符合要求会失败。输出文件包含实际凭据，使用 `0600` 权限且禁止覆盖已有文件。**输出是服务端配置材料 JSON，不是 dotenv 文件；不能将 `.json` 直接复制或重命名成 `.env`。** 后续需通过受控部署解析、注入对应服务端变量，并保留原有其他生产配置。配置可解析仍不代表商户权限、模式或付款到账已验收。

如需只读检查已由受控部署生成的 dotenv 文件，命令应保留脚本前的 `--`，避免 Node 将 `--env-file` 当作自身启动参数提前读取：

```sh
node -- scripts/check-scan-payment-config.mjs --env-file /受保护目录/payment.env --provider alipay
```
