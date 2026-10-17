# 用户独立供应主备 Key 验收（2026-10-04）

需求：为每个三阶注册用户配置独立的上游主 Key 和备用 Key，保留已有用户、配置、历史、媒体和已发布功能。

## 当前已核对的生产事实

- 已于 2026-10-04T09:09:13.202293+00:00（北京时间 17:09）完成生产发布。当前 release 为 /opt/sanjie-releases/20261004-user-supply-v2，PM2 159、PID 1935063、端口 31987，状态 online、restarts 0；原 Seedance PM2 158 保留。
- 90 个 active 用户、1 个 disabled 用户；本次 active 用户需 180 把供应 Key，停用用户不新增配发。
- user-supply candidate-v2 源码已冻结，以当前 Seedance 生产发布为基线；独立审阅的 bundle-v3 包含 34 个文件，其中 19 个生产文件。
- Fresh inspect、prepare、精确生产 migration 和代码切换均已完成；随后已为 90 个 active 用户提交 180 条加密 pending 凭据记录。停用用户未新增预配记录。
- 服务端仍缺上游配发账号 email/password、groupId 及显式 quotaUsd；真实上游签发为 0/180，图像创作仍未跑通。pending 密文不代表已就绪的上游 Key，因此本次用户需求尚未完成。
- 生产 Nginx SHA256：2c44c78b87c3984927d69b50a778ae1258f3b9f9f6330b7dafe88c21e171741c。

## 实现与边界

独立 Key 使用不可变 userId 绑定，两槽唯一；Key 全量在服务端加密，不向普通用户、管理列表或错误返回。先持久化同一 pending 密钥再调用上游，避免重复点击、注册重试或响应丢失后生成另一组 Key。注册提交与上游签发失败分离。批次只处理正常账号的到期任务，主 Key 优先，已有 ready 配置保留。

上游采用已验证的 Sub2API 用户 JWT 配发 API，以可重复的 custom_key、幂等键及创建后 GET 读回核对 key/name/group/owner。不借用其他用户供应凭据。默认创建速率为 60 把每小时；实际配置后分批补齐，429 至少退避一小时。

仅已验证的认证 middleware 未受理拒绝允许使用备用；超时、429、5xx 或任务受理线索不二次发送。视频和未确认计费任务保留实际 credentialId，查询沿用创建凭据。现有账本、冻结汇率、预留/发送/未知/释放/结算生命周期在最新生产基线上保留。

## 验证记录

- 冻结候选综合测试：2915 项通过、109 项跳过；lint、typecheck、build 退出码均为 0。
- 隔离 PostgreSQL 验证：171 项通过、6 项可选检查未执行，覆盖真实 SQL、并发、密文隔离、不可变身份、响应丢失恢复、公平调度与迁移 guard。隔离 fixture 与以下实际生产迁移、预配回执分别记录。
- 上游配发和加密配置、注册、管理表单及路由 tests 使用假供应，不代表真实上游签发成功。
- bundle-v2 首次 inspect 因候选端口列表仍包含实际旧端口 31986，被现有 guard 以 Candidate port rejected 拒绝；未生成该次 seal，也未迁移或切换。bundle-v3 在冻结工具中按 fresh pins 过滤旧端口，并继续排除保留端口 32011，原端口 guard 未放宽。
- bundle-v3 与 bundle-v2 的 manifest 和 34 个 overlay 文件字节相同；runner 仅候选端口常量变化。本地 verify-bundle 与独立复审均通过。
- bundle-v3 runner SHA256：f3c9dc0d0a3cf17e9371f73fdf329136dcbdd0f81355e6a7c736e1f4565009c2。
- manifest SHA256：4a89eb390fbe65c37dbb075f36b586e0371b736226dd9dd8bff5e1ef217dfe52。
- 已通过的 fresh inspect seal SHA256：ccd18ff831eb6824ff5ef3144eeb1879b98b2185a89e55f5d0eff4fc95176e8e。
- 实际生产发布检查：predeploy、lint、full tests、targeted tests、两套 UI 检查、typecheck、build、server canary 全部 PASS；31 项 publicChecks 通过。
- 已执行 20261004160000_user_supply_credentials 的精确 5 条 DDL：新增供应凭据表、两个索引及两个 nullable credentialId 列；未运行全套 migrate deploy。
- 生产 pending 预配前 inspect：90 个 active 用户、既有槽位 0、缺失槽位 180。apply 插入 180 条，pendingWriteCommitted=true；真实 provider 调用 0、真实上游签发 0。
- 提交后再次 inspect：既有 active 槽位 180、缺失槽位 0、inserted 0，未重复新增。
- 真实 Chrome 渲染核验：91 个注册用户、90 个 active、1 个 disabled；180 个槽位显示待发行、0 个已就绪，另 2 个待配置槽位属于停用账号，未为其新增 pending 记录。
- 安全配置表单已在 [生产主备 Key 管理面板](https://shaozhuangai.com/models?tab=api#user-supply-heading) 打开；[真实 Chrome 表单截图](uat-user-supply-20261004/live-user-supply-form.png)。待管理人员填写配发账号及显式额度后，仍需实际签发和图像创作验收。
- publication receipt SHA256：a0bbbc8a59458415209170ee6ef6c0ab22e7c9becd6080741c12ce80f816509b。
- publication state SHA256：9cf025a054b75df819ff6d17b81d5f09dda0ccbac6a82cbaace19a37984342a2。

## 发布范围

本次从已核对的 Seedance 生产基线添加精确 overlay，使用共享部署锁和新鲜 live fingerprint，只应用 20261004160000_user_supply_credentials 的新增表及两个 nullable binding 列，未运行全套 pending migrations。旧进程、原始媒体、历史下载及私有配置均保留；后续若回滚代码，仍须保留新增 schema、180 条 pending 密文记录和原有独立加密密钥。

已发布的目标为 user-supply-v2；bundle-v3 是修复端口候选列表后的独立工具封装，manifest 与产品源码未变。prepare 已使用强制网络 namespace、假供应及不存在的私有配置路径完成离线检查，线上 native video、relay 和 issuer 的配置引用、文件及祖先目录/软链 metadata 保留。冻结 runner 已在实际发布阶段完成生产能力、数据库容量、迁移历史、共享锁与切换 CAS 检查。部署和 pending 预配已完成；上游签发及图像创作仍等待配发配置，不能将整体任务标记完成。
