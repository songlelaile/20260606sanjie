# 三阶引擎支付宝 / 微信扫码充值接入（2026-10-02）

## 交付状态

已在本地源码接入三阶引擎充值入口，完成真实组件 Chrome 验收、自动化测试与隔离目录生产构建。**尚未部署到正式站，尚未完成真实商户下单、扫码付款、公网回调和真实到账验收。**

支付宝现有商户工作台实际显示「请填写公钥信息 / 应用公钥」，接入配置仍未完成。微信商户申请页面被浏览器站点安全策略阻止访问，本次没有尝试绕过，因此无法确认微信申请状态。本地支付环境未发现已配置的支付宝 / 微信支付凭据。

## 已实现的行为

- 工作台开通套餐、模型额度页套餐、创作积分「积分充值」进入同一支付弹窗。
- 保留服务端套餐：体验版 ¥99 / 1200 积分，增长版 ¥299 / 3800 积分，团队版 ¥899 / 12000 积分；没有套用参考站价格。
- 先选择支付宝或微信，再创建对应订单与二维码。每个官方二维码只由对应支付 App 扫描，未实现聚合单码双扫。
- 金额、额度、用户归属取自服务端；前端不能指定应付金额或把订单改为已付。
- 15 分钟倒计时；5 秒自动查询；「我已完成支付」只查单；到账后刷新余额与权限；过期隐藏二维码，允许查询已经发生的付款。
- 未配置的渠道禁用且不显示付款码，保留原人工收款确认流程。
- 服务端签名请求、验签响应和通知；微信通知 AES-256-GCM 解密；核对商户 / 应用、订单、人民币金额和成功状态后入账。
- 订单、钱包和充值账本在一个数据库事务内提交；同一渠道流水只入账一次，回调与主动查询并发不重复充值；失败全部回滚。
- 创建超时保留 pending 订单，重试沿用同一商户订单号。过期只改变展示，仍接收合法延迟到账通知。
- 只放行两个精确 POST 回调路由，其他支付路径仍要求原有登录与跨站校验。

## 商户配置与上线前置

配置模板在根目录 `.env.example`，真实密钥只置于服务端环境，不进入前端、Git 或聊天记录。

支付宝采用国内直接商户「当面付」预创建接口、RSA2 密钥模式，需完成对应产品开通和应用配置：

```text
ALIPAY_APP_ID
ALIPAY_SELLER_ID
ALIPAY_PRIVATE_KEY
ALIPAY_PUBLIC_KEY
```

`ALIPAY_PRIVATE_KEY` 是应用私钥；`ALIPAY_PUBLIC_KEY` 是支付宝公钥，两者不要混淆。支付宝后台填写的是应用公钥，私钥不上传。代码要求完整 PEM；支持以字面 `\n` 表示换行，不直接接受缺少头尾的裸 Base64。

微信采用 Native API v3、微信支付公钥模式，需商户审核通过、Native 权限与已关联 AppID：

```text
WECHAT_PAY_APP_ID
WECHAT_PAY_MCH_ID
WECHAT_PAY_PRIVATE_KEY
WECHAT_PAY_SERIAL_NO
WECHAT_PAY_API_V3_KEY
WECHAT_PAY_PUBLIC_KEY
WECHAT_PAY_PUBLIC_KEY_ID
```

APIv3 密钥为 32 字节；`SERIAL_NO` 是商户 API 证书序列号，`PUBLIC_KEY_ID` 是微信支付公钥 ID。当前不支持旧平台证书验签模式，迁移中的商户须先完成公钥切换。私钥 / 新凭据的后台设置和身份验证由商户本人完成。

```text
SCAN_PAYMENT_NOTIFY_BASE_URL=https://shaozhuangai.com
支付宝通知：https://shaozhuangai.com/api/payments/alipay/notify
微信通知：https://shaozhuangai.com/api/payments/wechat/notify
```

人工入口仍保持 `MODEL_GATEWAY_PAYMENT_PROVIDER=manual`；扫码渠道独立配置。仅凭配置项齐全不能证明商户权限有效，正式启用必须完成真实联调。

下一步：完成商户凭据配置后，在候选环境验收真实下单与通知，核对订单 / 收款流水 / 积分三者一致，再发布并验收正式域名。真实付款由用户操作；本次没有发起真实资金交易。

## 验证证据

- 149 项支付协议、API、middleware、弹窗 / 积分测试通过。
- 14 项模型额度页 / 网关 UI 回归通过。
- 32 项真实本机 PostgreSQL 隔离 schema 测试通过（人工支付 9、扫码支付 10、账本 13），测试结束清理自身 schema，没有修改业务库。
- TypeScript 通过；独立复制目录的 `next build` 通过，使用不可连接的占位数据库地址，未覆盖现有 `.next`，未读取生产凭据。
- 构建存在其他既有文件的 lint 警告，本次新增支付文件相关警告已修复。
- 独立复核发现微信新版 `/bizpayurl/up` 合法二维码路径需兼容，已修复 adapter 和二维码视图并加入官方示例回归。

真实 Chrome 操作验证：支付宝和微信渠道选择；套餐金额；倒计时；手动查询不自行入账；到期隐藏旧二维码；模拟到账后刷新回调；未配置渠道禁用；人工订单保留；下单错误提示与重试按钮。

浏览器证据使用真实 React 组件与本地内存接口，所有二维码编码「本地交互验收，不能付款」，截图底部有明显演示标识。**这些截图不是线上或真实付款证据。**

本地复现：`node scripts/preview-scan-payment.mjs`，访问 `http://127.0.0.1:18813/`。脚本只监听本机、只使用内存数据，不连接业务数据库或支付渠道。

截图位于 `docs/uat-scan-payment-evidence-20261002/`：微信、支付宝、过期、到账、未配置、失败状态。

## 官方协议参考

- [支付宝预创建](https://developer.alibaba.com/docs/api.htm?apiId=862&docType=4)、[订单查询](https://developer.alibaba.com/docs/api.htm?apiId=757&docType=4)、[支付通知核验](https://developer.alibaba.com/docs/doc.htm?articleId=106448&docType=1&treeId=193)。
- [支付宝官方 SDK 的绝对过期时间字段](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePrecreateModel.java)。
- [微信 Native 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)、[支付回调](https://pay.wechatpay.cn/doc/v3/merchant/4012791861)、[微信支付公钥](https://pay.wechatpay.cn/doc/v3/merchant/4013038816)。
