# 网站防照搬与管理员 AI 授权通道

日期：2026-10-02。当前文档状态为**v7 手动不限期授权已封包，实际当前基线 binder 通过，远程 prepare 已启动；尚未 publish，不能称为生产授权开关已上线**。root 已确认，v6 的 31956 后来被另一已授权创作发布 `studio-main-v1`／31957 替换；v7 从该当前版本准备新候选 `security-channel-v5`／31958，保留新创作 UI。最终发布时间、服务器计数、发布回执及真实浏览器截图待取得后再收口。

v6 于北京时间 14:41:31 发布、44 项公网检查及真实 Chrome 四工具选择和主图→详情→主图 iframe 验收均保留为历史。v3 首次失败自动回滚、v4 创作 iframe 500 后人工回滚及 v5 成功记录同样保留。v6 验收时原管理员登录、西西礼店铺、草稿素材和模型保留，没有创建生产 AI 授权或执行获准 AI 业务动作、生图、付款、上传、付费供应商调用；最近操作已有验收读取请求的审计记录（查看通道、查看最近操作），结果为横线，不判断成功或拒绝。这些历史记录不替代 v7 的发布与业务验收。

## 两份代码的适用范围

| 范围 | 创作资源访问 | 安装包与更新 |
| --- | --- | --- |
| 当前主工作区，含未发布的 v7 授权改动 | 使用现有开发目录的创作授权函数，核对有效账号及邀请/付款权限；这份实现不是生产收费策略 | 已知创作产品族 ZIP 经过受保护下载路由；未知 ZIP 拒绝 |
| v6 历史生产兼容实现；v7 沿用其业务权限边界 | 实时核对签名会话、账号状态、租户与角色，**保留生产既有的有效登录账号工作台访问规则，不新增充值或付费门槛** | 默认保留下文四个精确 ZIP 地址及现有公开更新约定；其余历史创作 ZIP 经过登录和已知产品族校验 |

v3 本地候选已补齐哈希核对后的实际线上源基线，并通过完整测试。实际部署仍从当前线上完整版本复制，只叠加已审安全文件；黄金约束使用的原报告引擎 JavaScript 不在 overlay 覆盖范围。不得直接用主工作区或本地候选目录覆盖线上站点，也不能把开发目录的邀请、付款或新账单逻辑带入生产。

兼容实现及说明位于 `.codex-deploy/anti-clone-20261002/production-candidate-README.md`、`production-overlay-v3/src/lib/creative-entitlements.ts`、`production-overlay-v3/src/lib/production-compatibility-policy.ts`。v4 发布使用 `security-channel-production-compat-20261002-v4.tgz`；`production-transport-receipt-v4.json` 确认 72 份业务 overlay 与 v3 相同，只修改部署 runner 的 Nginx reload 后就绪等待。`publication-receipt-v4.json` 证明曾经切换成功，不包含之后真实 iframe 回归失败和人工回滚，不能作为当前在线结论。

v5 历史包 `security-channel-production-compat-20261002-v5.tgz` 为 149146 字节，SHA-256 为 `7da4dd8301a542a30ae6c57400768387a28c24544553f8e52fcfe748e28d3d5e`，本机已与 `production-transport-receipt-v5.json` 逐项核对。仍为 72 份 overlay，只改 `next.config.mjs`、`src/middleware.ts`、`src/middleware.test.ts` 三个文件；其余字节和原 before 描述保持不变。该版本的生产同源修复与既有权限由 v6 保留。

v6 包 `security-channel-production-compat-20261002-v6.tgz` 为 157325 字节，SHA-256 为 `dbce3136647ef7623ae4029454a6ab1e5cae7eff6767b493273336fbc2d7d67b`。72 份 overlay 中仅 UI 三个文件和生产兼容测试一个文件变化；实际运行变更只涉及页面 TSX 与 CSS，其余 68 份字节及原 before 描述不变，后端业务权限不变。`publication-receipt-v6.json`、`production-acceptance-v6.json` 和 v6 Chrome 验收证明该历史版本，不证明当前创作版本或待发布的 v7 状态。

v7 已封包为 `security-channel-production-compat-20261002-v7.tgz`，209663 字节，SHA-256 为 `8d5ccdf55bf6d43266a553dd2dad059bcc781487bbb57264f34b147fab670903`。73 份 overlay 包含 9 份变更的既有 AI 文件（含测试）和 1 份新增手动授权 SQL，其余 63 份与 v6 字节相同；当前创作版本的 18 份 UI overlay 保留。复制基线已改为 `/opt/sanjie-releases/20261002-studio-main-v1`／31957，实际 667 份源文件 binder 通过，构建基线 596 份已核对。root 已经 Workbench 启动远程 prepare，PID 1602702；目标为 `/opt/sanjie-releases/20261002-security-channel-v5`／31958，回滚恢复当前 studio 31957。封包与启动 prepare 不等于服务器检查完成或正式发布。对应 [v7 本地封包验证](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/security-channel-production-compat-20261002-v7/v7-local-verification.json) 及 [v7 封包传输回执](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/production-transport-receipt-v7.json)；后者为绑定前快照，后续实际 binder 结果与启动进展单独记录。

## 管理员授权入口（v7 待发布设计）

管理员进入 `/management/ai-access`，手动创建授权。新通道默认只读、默认关闭；先保存仅展示一次的令牌，再由管理员明确点击开启。开启后不限时间，直到管理员手动关闭；关闭后可使用同一令牌重新开启。“永久撤销”不可恢复，需要重新创建新通道。创建接口不再接受 `durationMinutes`，开关接口只接受布尔值 `enabled`。每次管理请求都核对当前有效管理员身份，只有自己的手动通道可以开关。页面加载只读取自己的授权和最近操作，不自动创建、开启、复制、发送或执行授权。普通账号不能打开管理页面，也不能创建、列出、开关或撤销授权。

新通道的公开 DTO 为 `expiresAt: null`，按开关状态、永久撤销状态及管理员身份判断有效性，完全不以时间到期。数据库保留非空的物理 `expiresAt`，新建值为 30 分钟，仅供回滚旧代码时使用原有限期安全窗口；新代码不据此限制手动通道。历史有限期通道保留原到期时间，不自动延长或转换，不接受开关 PATCH；管理员需新建手动通道。

页面遵循三阶的深绿卡片与金色按钮，复用全局颜色变量。AI 工具提供 `Codex`、`Cursor`、`Claude Code`、`通用 AI` 四项，默认 Codex；管理员选择仅决定授权记录的名称。名称是管理员标签，不证明请求来自该品牌客户端，也不增加权限。所有工具使用同一管理员手动开关、操作白名单、限流和审计规则；选择名称不会自动开启通道。

令牌含 256 位随机秘密，只在创建成功的响应中返回一次。数据库只保存 SHA-256；页面仅在内存中显示，关闭令牌展示、离开页面或永久撤销授权后清除，开关接口不返回或轮换令牌。令牌不替代网站 Cookie，不授予普通接口权限。手动关闭、永久撤销、管理员禁用、降级、改名或租户变化会阻断后续授权；历史有限期通道仍在到期后失效。关闭事务提交后，新授权及后续有效性检查拒绝访问；已经受理的在途请求不会被强行取消，不能把“立即关闭”解释为取消已开始的工作。

暂停状态在数据库中以同一精度的 `disabledAt = revokedAt` 表示，旧代码也会拒绝该令牌；重新开启只清除可恢复的暂停状态。永久撤销清除 `disabledAt`，保留非空 `revokedAt`。新版开关先锁定所属手动通道，再以新 SQL statement 检查不存在已提交的 `revoke` 审计，防止旧版 DELETE 在回滚期间撤销暂停通道后被误当作可恢复状态；列表也依据该审计显示永久撤销。开关、永久撤销及各自审计在同一事务内，审计失败不确认操作成功。

统一调用入口是 `POST /api/ai-access/execute`，仅接受 `Authorization: Bearer <管理员手动创建的令牌>`。支持同源使用和无 Origin 的 CLI 调用；外部浏览器来源目前不开放。请求体是严格白名单操作：

| 方法 | 路径 | 范围 |
| --- | --- | --- |
| GET | `/api/auth/me` | AI 通道身份摘要，不返回 Cookie 或会话令牌 |
| GET | `/api/auth/creative-access` | 当前创作访问权限 |
| GET | `/api/shops` | 授权账号的租户店铺 |
| GET | `/api/v1/models` | 可用模型的公开元数据 |
| GET | `/api/dmp-reports` | 授权账号、指定店铺的报告列表或报告 |
| PATCH | `/api/shops/active` | 仅“允许操作”，改变 AI 授权的店铺上下文 |

所有读取均绑定原管理员及租户。报告额外核对现有工具权限、报告所有者和指定店铺；没有指定店铺时拒绝，不以第一家店铺或其他报告替代。创建授权绑定浏览器当前选中的合法店铺；只读授权需要换店时，先切换人工浏览器的当前店铺，再手动创建新通道。允许操作的 AI 切店只更新该授权自身的上下文，不改变用户浏览器的店铺 Cookie。

执行器直接调用指定服务，不代理任意 URL、不转发用户 Cookie、不生成网站会话。禁止额外请求头、任意租户字段、未开放方法、上传、删除、分享、账号权限修改和付费模型调用。现阶段“允许操作”仅支持切换 AI 自身店铺。

请求在授权前计入可信来源/未知来源和令牌摘要的尝试额度；授权后按账号计入每分钟 60 次，包括只读令牌越权尝试。创建授权为每小时 20 次，管理员开关为每分钟 60 次。额度和前置审计通过后才能执行动作；数据库或审计不可用时返回 503，超限返回 429 和 Retry-After。记录创建、开启、关闭、授权、永久撤销、上下文变化和操作的静态路径、结果与时间，不记录原令牌、查询串或请求内容。页面“最近操作”只显示最近 20 条元数据，并提供手动刷新；接口最多返回当前管理员自己的 100 条记录。

## 网站资源与接口保护

- Node middleware 对保护范围的请求实时核对账户状态，按稳定账号限流；跨站浏览器写操作先核对可信 Origin。
- 私有源码、环境文件、备份、数据库文件和 source map 返回 404。生产构建关闭浏览器 source map，核心三阶算法标记 server-only，客户端只引用展示配置。
- 创作 HTML 及功能脚本经过服务端授权资源路由；路径、类型、真实文件路径及符号链接边界都有校验。使用 no-store、nosniff、同源资源与 frame-ancestors 约束；保留同源工作台 iframe。
- 受保护下载仅识别 `sycm-keyword-collector-vX.Y.Z.zip` 和 `shaozhuang-ai-vX.Y.Z-macos-full.zip` 两个已确认的创作产品族稳定版本。授权核验后，未知产品、目录、非普通文件与所有文件符号链接别名统一返回 404；下载根目录既有部署链接可保留。GET 使用文件描述符流式输出，HEAD 只返回元数据，不修改原包。生产四个精确公开 ZIP 例外另见下文，不能据此声称全部安装包已受登录保护。
- 登录、注册和创作上游请求有 PostgreSQL 原子共享额度，多进程和重启不重置额度。不依赖 User-Agent 黑名单。
- 请求声明 `x-sanjie-ai-client` 或使用 `sja_` AI 令牌时，只能进入统一执行通道。

生产已有精确认证的 DMP、Sower、视频及 API key 接口保留各自认证方法；不得用广泛的 Cookie 门禁代替它们。兼容候选的模型目录只返回公开 id、label、kind、provider，不带上游名称、环境变量名、密钥、配置或供应商 URL，也不引入开发目录的 relay/账单调用依赖。

`security/nginx/` 是独立可审查的 http/server 配置配套。本机 Nginx 沙盒通过不表示这些片段已合入生产；现有代理 location、真实 IP 信任链、上传大小、WebSocket 和 upstream 策略均须按真实完整配置审查，不能直接替换。v6 发布的防护主要通过 Node middleware 和路由实施上述边界；当次生产 Nginx 的变更是已绑定默认入口切换。v7 尚未进行生产切换。

## 公开分发默认兼容，收紧策略待用户偏好

本次已授权的网站防护、管理员 AI 通道与 Workbench 发布默认保留以下**四个精确地址**的现有匿名分发约定，未使用 ZIP 通配放行。用户暂未回答下载偏好时，按这一兼容方案推进完整验证与发布，不把偏好答复作为本次上线前置条件：

| 版本 | 地址 |
| --- | --- |
| v1.9.80 | `/downloads/sycm-keyword-collector-v1.9.80.zip` |
| v1.9.80 | `/downloads/shaozhuang-ai-v1.9.80-macos-full.zip` |
| v1.9.83 | `/downloads/sycm-keyword-collector-v1.9.83.zip` |
| v1.9.83 | `/downloads/shaozhuang-ai-v1.9.83-macos-full.zip` |

现有 `/api/tools/updates/ai-automation/latest`、`bootstrap` 和严格版本 `package/<version>` 更新接口保持原约定；其他相似前缀不会因此公开。是否切断这些公开安装包和更新约定、迁移到登录或独立更新凭证，仍等待用户明确偏好，并需真实客户端安装、更新与回退验收后实施。这一后续收紧策略与本次默认兼容发布分开处理。

公开完整包包含客户端功能代码，保留公开更新兼容性也保留了这一逆向获取渠道。本次已发布防护减少匿名网页资源和其他历史包的获取，不消除上述四包的公开性。不能把保留原文件、签名和 URL 当成真实更新验收已经完成。

部署保留原配置、数据库业务数据、媒体、已发布安装包、更新签名、原进程及其登录状态。prepare 只准备候选 release、构建及回环 canary；publish 才执行已审迁移和唯一默认路由切换。v3 失败后曾恢复原入口并保留新增表；v4 人工回滚后曾恢复 31948；v5 入口为 31955。v6 当时从 31955 切至 31956，回滚目标为 v5 的 31955，复制 baseline 为原目录 31948。此后另一次已授权创作发布已切至 `studio-main-v1`／31957；待发布 v7 必须从这一实际当前版本复制，计划候选为 `security-channel-v5`／31958，不能用历史 baseline 覆盖新 UI。v7 的当前源码、构建、路由与回滚绑定须由最终回执确认。

## 代码与本地验收证据

证据目录为 `.codex-deploy/anti-clone-20261002/`。以下各组作用于不同范围，测试数不能相加后称为新的完整套件：

| 范围 | 已有证据 | 不能据此推断 |
| --- | --- | --- |
| 此前主工作区完整质量门 | `ai-full-quality.log`：typecheck、lint、test、build 成功；137 个测试文件通过，1793 项通过、30 项既有跳过 | 不含此次 v7 后续改动，不是最终下载收紧补丁和生产兼容 variant 的完整线上验收 |
| 最新本地受保护下载边界 | 56 项真实临时文件系统测试及 typecheck 通过，包含未知 ZIP、同目录/内目录符号链接、根目录部署链接、FIFO、流式校验和与 HEAD | 不证明生产公开四包已改为受保护下载 |
| 此前 AI 路由与直接操作单测 | 新增 3 个测试文件、82 项通过；前置两级尝试额度、账号额度、审计失败、令牌/DTO/店铺边界 | 使用 mock，是手动开关改动前的证据，不等于真实生产管理员调用 |
| v6 管理员页面与交互 | 29 项 source/UI 测试及 typecheck 通过；四个工具名称、默认只读/30 分钟、手动令牌生命周期、三阶样式；原 middleware-security 23 项通过 | mock/source 检查不等于真实客户端配置或生产创建授权 |
| v7 手动授权后端，尚未发布 | 相关 5 个文件/177 项单元测试及 `npm run typecheck` 通过；默认关闭、公开到期为 null、布尔开关、管理身份/额度/请求体、暂停与永久撤销 SQL、旧版撤销审计边界 | 单元测试使用 mock；不等于真实数据库或生产执行，也不与旧 82 项叠加计数 |
| v7 手动授权页面，尚未发布 | `manual-channel-ui-root-tests.log`：1 文件/59 项通过；`manual-channel-ui-root-typecheck.log`：类型检查通过。覆盖默认只读/关闭、取消固定时长、明确开启/关闭/永久撤销与四工具标签 | source/UI mock 检查，不证明真实生产开关交互或客户端配置 |
| v7 真实隔离 PostgreSQL，尚未发布 | `ai-postgres-manual-control-test.json`：本机 PostgreSQL 14.22、三条迁移、31 项实质检查通过；15 轮关闭/授权并发、3 轮旧版撤销实锁等待；临时实例已停止 | 31 项为集成脚本记录的检查，非新增 31 个 Vitest 测试；不是生产迁移、生产令牌或 provider 验收 |
| v7 迁移 runner 离线反例 | `security-channel-production-compat-20261002-v7/manual-migration-cas-review.json`：精确五语句、重放零 DDL、marker/结构/checksum 失配拒绝与故障回滚通过 | 内存 catalog/事务 fixture，`databaseRequests: false`；不能并入真实 PostgreSQL 的 31 项，也不证明生产迁移完成 |
| v7 已封包候选，尚未 publish | `security-channel-production-compat-20261002-v7/v7-local-verification.json`：候选 6 文件/325 项全部通过，typecheck 0、Next 15.5.23 构建成功；runner 28、binder 7、路由/恢复 5、失败 4、就绪 3 及 catalog 20 项反例通过 | 各组范围分别记录，不合并为完整套件；不能替代服务器原依赖上的 prepare、生产迁移或浏览器验收 |
| 独立 Nginx 配套 | 本机真实 Nginx 临时配置的语法和回环运行检查 94 项通过 | 不证明生产 real-IP、location 或相关片段已经启用 |
| v3 实际线上源生产兼容候选 | `production-candidate-live-tests.log`：128 文件、1706 项全部通过，没有排除测试文件；typecheck 通过，`production-candidate-live-build.log` 记录 Next 生产构建成功 | 该完整证据先于 v5 三文件修复；不称为 v5 的新完整本地套件，不等于生产或浏览器验收 |
| v5 代理 rewrite 修复 | `security-channel-production-compat-20261002-v5/v5-local-verification.json`：候选 typecheck 0、相关 6 文件/200 项通过；runner 26 项、失败检查 4 项、就绪检查 3 项和数据库形状反例 8 项通过 | 验证范围是此次修复与部署边界，不替代生产或真实浏览器验收；本地未连接生产数据库或付费供应商 |
| v6 UI 与路由绑定候选 | `security-channel-production-compat-20261002-v6/v6-local-verification.json`：6 文件/183 项通过，typecheck 与 Next 15.5.23 构建通过；当前路由来源 4 项、runner 26 项、失败 4 项、就绪 3 项及数据库形状反例 8 项通过 | 该候选的本地验证范围，不替代服务器 Next 15.5.19 与真实浏览器验收；未执行数据库或供应商请求 |
| 真实 Next 15.5.19 回归复现 | `next-proxy-rewrite-15.5.19.json`：原 HTTP 200/HTTPS-forwarded 500，修复后两者均 200，HTML、MIME 与同源安全头正确；隔离服务已停止 | 真实框架级复现不等于生产发布后的 iframe 验收 |
| 本地 Next 匿名 HTTP | `production-candidate-anonymous-http.json`：13 项通过，含登录、资源/map、AI 未授权与历史 ZIP 边界 | 未执行真实登录、创建授权、付款、生成或供应商请求；四个大公开包不在本地快照中，须独立服务器 stage HEAD 验证 |

原真实隔离 PostgreSQL 记录包括 30 并发额度争用、跨进程计数、窗口恢复、过期清理，以及首次有限期 AI 授权的 17 项检查：权限与租户隔离、仅摘要保存、撤销/到期/账号变化、审计故障事务回滚、15 轮并发授权/撤销。它们是此前版本证据，不替代 v7 手动开关的重新验收。

v7 使用 `scripts/test-ai-access-postgres.mjs` 启动全新本机回环临时 PostgreSQL，先在旧表结构插入有限期授权，再应用第三迁移。31 项实质检查包含：旧授权不转换或延期；新建默认关闭且只存摘要；新手动授权超过物理到期后仍可用，关闭与同令牌重开仍有效；微秒暂停状态与重复关闭；永久撤销关闭通道后不可恢复；账号/租户/店铺隔离；创建、开关、撤销、上下文及授权审计故障事务回滚；15 轮并发关闭/授权，关闭提交后新授权拒绝。另 3 轮通过 `pg_stat_activity` 实际观察新版开关等待旧版撤销行锁，提交旧 `revoke` 审计后新版以新 statement 拒绝开启，列表显示永久撤销。该测试没有用 sleep 模拟到期，也没有将顺序调用冒称为并发。

实际记录为 [v7 隔离 PostgreSQL 回执](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/ai-postgres-manual-control-test.json) 和 [完整日志](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/ai-postgres-manual-control-test.log)，回执 SHA-256 为 `77efc071c244c752803628a56f7e68625e4c52888960b673610536246112005b`。临时实例已停止并清理；未连接生产数据库，未生成共享 Prisma client，未调用付费供应商。真实 PG、单元/UI mock 及 runner catalog 反例分别记录，不把检查数合并为生产验收计数。

`production-candidate-tests.log` 保留首次候选诊断：工具页版本基线不一致和缺少原 predeploy guard 导致 2 项断言失败，报告引擎 JS 缺失导致 1 个测试文件加载失败。先补齐正确版本基线/guard 后，旧 `production-candidate-available-tests.log` 的 119 文件、1542 项通过；随后 v3 从实际线上源补齐原报告引擎，两个文件的哈希精准匹配黄金约束，原报告引擎 3 项测试通过，最终完整套件为 128 文件、1706 项通过。原引擎未放入部署 overlay，未以开发版替代。首次失败和中间局部通过日志均保留，最终证据不再把缺失引擎列为未解决的本地阻塞。

此前真实数据库记录为 `postgres-test.json` 和 `ai-postgres-test.json`。原两份 CREATE-only 迁移及其字节保持不变，分别建立 SecurityRateBucket 和 AI 授权表。v7 另加第三迁移 `20261002170000_ai_access_manual_control`，SHA-256 为 `9d065c1b80738527f1a6ff648b038c39c63b479e919eeae7df1b2a7166ca92c6`；仅对 AI 专属表执行固定五条 ALTER：新增默认 FALSE 的非空 `manualControl`、可空 `disabledAt`、严格暂停状态约束，并按指定语句替换事件类型约束以追加 `enable`/`disable`。不再将全部迁移描述为 CREATE-only；原期限约束、历史授权、令牌摘要及业务表均保留。

迁移 runner 先在事务锁内核对旧完整 catalog 与原迁移 marker；没有第三 marker 时才允许执行固定五条语句，核对新完整 catalog 后写入第三 marker，失败回滚 DDL 与 marker。已存在第三 marker 时核对 checksum 和新结构，重放零 DDL；部分结构、异常 marker 或未批准 ALTER 均拒绝。应用回滚保留新增列和迁移历史，不能再用只接受旧 catalog 的历史 runner 发布新结构。prepare 不改数据库，publish 后才有生产迁移结果；本地反例检查和真实隔离 PG 都不代表该迁移已在生产执行。部署不重建共享 Prisma client，不覆盖旧客户或业务表。

## 生产发布记录（历史与待发布）

本地候选构建使用 Next 15.5.23；v3/v4/v5/v6 真 ECS prepare 使用既有服务器依赖 Next 15.5.19。两者分别记录，不用本机构建替代服务器证据。各 `stage-review` 是 prepared 快照，不能把其中 `published: false`、迁移尚未执行的早期字段当成之后 publish/rollback 的最终状态。v5/v6 的成功回执均为历史记录；v6 后的当前创作版本为 `studio-main-v1`／31957，v7 候选准备中，尚无本次正式发布或生产开关验收结论。

| 阶段 | 当前已知结果 | 证据范围与限制 |
| --- | --- | --- |
| v3 真 ECS prepare | 28 文件、627 项测试通过；类型检查、生产构建、完整原发布 guard 通过；loopback 40 项检查通过 | `stage-review.json`；包含签名会话 canary、四个公开 ZIP HEAD 和更新元数据兼容检查，不是人工管理员浏览器会话 |
| v3 publish 迁移 | 两份 CREATE-only SQL 执行成功，新增 SecurityRateBucket、AIAccessGrant、AIAccessEvent 表保留；迁移后 canary 42 项通过 | 部署主流程与 v4 候选说明保留此记录；v4 发布回执再次严格复核现有表。没有覆盖原客户表、生成共享 Prisma client 或创建 AI grant |
| v3 公网切换与自动回滚 | Nginx reload 后立即公网检查，`/.env` 返回 307，未达到预期 404，因此自动回滚；原 default 31948 和完整 Nginx 哈希恢复 | 此次发布尝试判定失败，不能写成在线成功。新增表和旧候选保留，未执行付费供应商请求 |
| v4 本地 runner 修复 | 每轮使用新连接，最多等待 30 秒，要求连续三轮 `/.env` 404 和声明式 AI 通道外请求 403 才进入完整公网检查；未改变完整检查预期 | `security-channel-production-compat-20261002-v4/readiness-test.json`：3 项就绪检查、既有 runner 21 项、失败/不可变复制 4 项、数据库形状反例 8 项离线检查通过；没有生产或数据库调用 |
| v4 真 ECS prepare | `20261002-security-channel-v2`、PM2 `sanjie-security-channel-20261002-v2`、回环端口 31954；28 文件/627 项、类型检查、Next 15.5.19 构建、完整原 guard 与 40 项 canary 通过 | `stage-review-v4.json`：原源文件 615 份、候选 665 份、构建封存 596 份；保持独立 v4 状态 |
| v4 publish 与 HTTP 验收（历史） | 上海时间 2026-10-02 10:36:30 曾切至 31954；迁移后 canary 42 项与公网 42 项通过；发布后完整原 guard、PM2 save 通过 | `publication-receipt-v4.json` 的 `published: true` 是当时的发布记录；两份迁移均 `createdTables: []`、`verified: true`。后续真实 iframe 回归失败，不能由此宣称当前在线 |
| v4 公网就绪 | 4 次尝试、1.615 秒内达到连续 3 轮新连接成功：`/.env` 404、声明式 AI 通道外请求 403 | 发布回执 `publicReadiness`；成功后再执行完整公网检查，没有降低原检查标准 |
| v4 真实创作 iframe 回归与人工回滚 | Chrome 提示页面被屏蔽；进一步确认签名公网 creative HTML 500、loopback 200。已通过原 runner 主动回滚，Nginx 语法检查与 reload 通过，原 default 31948 和原 Chrome 主图 iframe 恢复 | 实际 v4 与隔离 Next 15.5.19 的代理 rewrite 问题一致；没有创建 grant 或调用付费供应商 |
| v5 真 ECS prepare | 新候选 `20261002-security-channel-v3`、PM2 `sanjie-security-channel-20261002-v3`、回环端口 31955；28 文件/631 项、完整原 guard、类型检查、Next 15.5.19 构建和 40 项 pre-canary 通过 | 原源文件 615 份、候选 665 份、构建封存 596 份；服务器结果与 stage 记录分开保存 |
| v5 publish 与增强验收（历史成功版本） | 北京时间 2026-10-02 10:59:40 正式发布；切换前签名主图 HTML/JS 及 HTTPS-forwarded 两轮共 46 项、增强公网 44 项通过；原 publication guard before/after 通过 | `publication-receipt-v5.json`：`published: true`、当时默认入口 31955；两份原已建迁移均 `createdTables: []`、`verified: true`，曾是 v6 的路由来源和回滚目标 |
| v5 公网就绪 | 4 次尝试、1.593 秒内达到连续 3 轮新连接成功：`/.env` 404、声明式 AI 通道外请求 403 | 最终回执 `publicReadiness`；其后完整公网 44 项通过 |
| v6 真 ECS prepare | `20261002-security-channel-v4`、PM2 `sanjie-security-channel-20261002-v4`、回环端口 31956；28 文件/650 项、类型检查、Next 15.5.19 构建、原 publication guard 和 40 项 prepare 检查通过 | `stage-review-v6.json`：复制源 615 文件、候选 665 文件、构建封存 596 文件；复制 baseline 31948，当前路由来源 31955 |
| v6 publish 与公网验收（历史） | 北京时间 2026-10-02 14:41:31 正式发布；postMigration 46 项、公网 44 项、原 publication guard before/after 通过 | `publication-receipt-v6.json`、`production-acceptance-v6.json`；两条既有迁移 `verified: true`、`createdTables: []`，当轮无新建 DDL；未创建 grant 或调用供应商 |
| v6 公网就绪 | 3 次尝试、1.064 秒内连续 3 轮新连接成功：`/.env` 404、声明式 AI 通道外请求 403 | v6 回执 `publicReadiness`，其后完整公网 44 项通过 |
| v7 手动不限期授权（prepare 已启动，未 publish） | 已封包；候选本地 6 文件/325 项、类型检查和 Next 15.5.23 构建成功；实际当前 studio 31957 的 667 份源码 binder 通过；Workbench 启动远程 prepare PID 1602702，候选 31958，保留新 UI | 正式发布时间、真实服务器类型/构建及检查计数、第三迁移生产结果、发布回执与浏览器截图均待 root 提供；准备进展不等于在线成功 |

v4 的历史发布时间为 `2026-10-02T02:36:30.627290+00:00`。本机已核对 `publication-receipt-v4.json` SHA-256 为 `c3401d02d427e67c8a1eece481d84fe01d02d941ffcc7428241774081c3649d2`；`stage-review-v4.json` SHA-256 为 `2fa6426059e54b78999a8a20ad74fa4628ad7578ab3e5f6baa10114307f47c88`。回滚使用 `/etc/nginx/conf.d/sanjie.conf.pre-20261002-security-channel-v2`，原入口已恢复；旧站点、候选与 Sower 进程及原状态按 CAS 边界保留。这些历史回执不覆盖后续人工回滚状态。

v4 短暂上线时的公网检查确认登录 200、匿名管理/创作资源跳转登录、私有文件/map 404、未登录 API 401、通道外声明式 AI 403、历史 ZIP 401、四个精确公开 ZIP HEAD 200、更新元数据兼容；签名 canary 的身份、创作权限、店铺及管理页面 200。该组检查没有覆盖发生回归的签名公网 creative HTML/JS，因此 HTTP 42 项通过不能代替真实 iframe 运行验收，也不能视为回滚后当前状态。公开下载/更新的硬切继续单独等待用户偏好。

v5 已确认根因：NextURL 将 `127.0.0.1` 规范化为 `localhost`，rewrite 后 origin 判断不一致，误将本应内部处理的请求外转为 HTTPS 请求 HTTP loopback，触发 EPROTO。最小修复为 `skipMiddlewareUrlNormalize: true`，并用原生 `URL(request.url)` 构造创作资源及受保护下载 rewrite。真实 Next 15.5.19 的生产构建/start 隔离复验从原 200/500 变为修复后 200/200；内容与原同源安全头同时验证，未使用数据库或付费供应商。

v5 历史正式发布时间为 `2026-10-02T02:59:40.883567+00:00`，北京时间 10:59:40。当时 release 为 `/opt/sanjie-releases/20261002-security-channel-v3`，PM2 为 `sanjie-security-channel-20261002-v3`，端口 31955。本机已核对 `publication-receipt-v5.json` SHA-256 为 `f2bb98031169de565eebb6e804406dfe17467dba044730c12bb4febb6838b5b5`。该成功版本保留，作为 v6 的回滚目标。

v6 当次公网 44 项包含带真实主图 query 的签名 HTML 200 和版本 query 的签名 JavaScript 200；二者 MIME、SAMEORIGIN、`frame-ancestors 'self'`、CORP same-origin、nosniff 均核对，内容字节按 runner 标准验收。匿名保护、签名账户访问、四个精确公开 ZIP 和更新元数据检查通过；当时完整保留 v5 的生产同源最小修复。

v6 历史正式发布时间为 `2026-10-02T06:41:31.702159+00:00`，北京时间 14:41:31。release 为 `/opt/sanjie-releases/20261002-security-channel-v4`，PM2 为 `sanjie-security-channel-20261002-v4`，端口 31956。已本机核对发布回执 SHA-256 `f4d36c7561cf6304e2fcaff1c52f675e33afe0c919011a7572f75144d618178d`、stage SHA-256 `133df819bac7fdf36c20ac87a517c6ca16f20bd7b9f89bcaf50074f58c30a800`。Nginx 当次切换前绑定 v5 的 31955 及 SHA-256 `24df867cf4eff0531fb12be201832ec8d718471688875396c8e8f9d94063ba5f`；发布后 SHA-256 为 `30a56ceec00bc3374a5b650d4d1317ab931ba2c27ceee9f3fda5e54e1744348a`。v6 备份为 `/etc/nginx/conf.d/sanjie.conf.pre-20261002-security-channel-v4`，当时回滚目标为 v5 的 31955、复制 baseline 为 31948；这些绑定不能直接用于当前 31957 上的 v7 发布。

北京时间 14:50:16，上线后严格 TLS 匿名只读 GET `/api/auth/me`，分别声明 `x-sanjie-ai-client: Codex`、`Cursor`、`Claude Code`，三项均返回 403 / `AI_CHANNEL_REQUIRED`。这验证声明式请求必须使用统一通道，不代表真实品牌客户端运行验收或视觉操作识别。[上线后三品牌 HTTP 记录](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/ai-client-public-http-v6-after.json)

## 真实浏览器与业务验收（v6 历史，v7 待验收）

原 Chrome 会话的四项工具选择、计算颜色、主图/详情往返、操作边界及截图 SHA 记录在 [v6 浏览器验收记录](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/browser-acceptance-v6.json)。发布和服务器记录分别为 [v6 发布回执](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/publication-receipt-v6.json)、[v6 stage 记录](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/stage-review-v6.json) 及 [v6 生产验收记录](/Users/shaozhuang/20260606sanjie/.codex-deploy/anti-clone-20261002/production-acceptance-v6.json)。

| 场景 | 已有结果或待验收状态 | 证据范围与限制 |
| --- | --- | --- |
| v6 历史公网 HTTP 边界 | 当次正式入口 44 项通过，包含签名创作 HTML/JS；v3/v4 失败回滚、v5 成功记录保留 | `publication-receipt-v6.json`；当时默认入口 31956，不是当前 31957 或待发布 31958 的验收 |
| v6 历史管理员页面与样式 | 原 Chrome 管理员登录和西西礼店铺保留，页面正常；三阶深绿卡片、金色按钮和深色按钮文字；旧版默认只读/30 分钟，暂无授权通道 | `production-admin-ai-access-v6.jpg` 已本地查看。真实样式读取为卡片 `rgb(13,23,8)`、按钮 `rgb(246,198,95)`、按钮文字 `rgb(8,15,4)`；不将截图描述改为不限期界面 |
| 四种工具选择 | Chrome 实际选择 Codex、Cursor、Claude Code、通用 AI 均成功，始终保持只读，最后回到默认 Codex | 仅切换下拉框；未创建、复制、撤销或执行生产令牌。工具名称为管理员标签，不认证客户端品牌身份或增加权限 |
| 最近操作 | 已有验收读取请求的审计记录（查看通道、查看最近操作），结果显示“—” | v6 页面已查看；不称为空表，也不据此判断成功或拒绝 |
| v7 手动开关界面 | 本地 source/UI 59 项通过，尚未取得真实生产浏览器记录 | 发布后再核对默认关闭、不限期、明确开启/关闭及原用户/创作状态；不能用 v6 30 分钟截图替代 |
| 管理员创建、调用、撤销 | 生产尚未创建 grant | 需人工明确操作的真实验收记录；不自动创建或调用付费能力 |
| 原用户创作工作台 | v6 发布后，真实 Chrome 主图→详情→主图 iframe 的标题和 URL 确认正确；原西西礼店铺、草稿素材和模型保留 | `production-creative-main-v6.jpg`、`production-creative-detail-v6.jpg` 已本地查看；未生成、上传或修改任务 |
| Cursor/Claude Code 客户端 | 未实际运行或配置客户端 | 已验收工具下拉标签和声明式 HTTP 边界，不声称真实客户端连接或电脑操作已验收 |
| 上传、生图与付款 | 未执行 | 当前证据不声称上传、生成、付款或供应商调用已验收 |
| 插件安装、更新与回退 | 四个公开 ZIP 与更新元数据已有服务器 canary 兼容检查，未完成真实客户端安装/更新/回退 | 原客户端状态保留及实际更新、回退记录；HEAD 或元数据相同不能代替客户端验收 |

v6 的发布、stage、生产验收记录及三张 Chrome 截图保留为该版本的历史收口证据；v3/v4 失败回滚与 v5 成功记录保留。当时网站防护、四工具选择、三阶样式、主图/详情 iframe 和原状态已验收；未创建生产授权、配置真实 Cursor/Claude Code 客户端或执行业务动作、上传、生图、付款、真实客户端更新/回退。审计列表已有读取请求记录，不将“暂无授权通道”写成“暂无审计事件”，也不判断记录成功或拒绝。v7 手动不限期授权仍在准备阶段，最终发布与浏览器结论须使用新回执，不能继承历史在线声明。

## 实际限制

普通浏览器里的 Codex、Cursor、Claude Code 或其他 AI 视觉点击，与人手点击没有可靠的服务端区别。工具名称是授权记录标签；声明式 AI 通道可以约束明确使用该通道的请求，未声明身份的浏览器操作仍按实际账户权限、资源鉴权和限流处理。不能据此宣称所有普通账号的 AI 点击都被识别和禁止。

已经送到获准浏览器的界面、样式和 JavaScript，仍然可以被有权限的人查看、截图或复制。公开插件更新包仍暴露其中的客户端代码。上述措施减少匿名获取、批量枚举和越权，不能保证功能绝不被模仿。客户端仍有部分创作计划/提示词合同；本次没有宣称它们已全部移到服务端。

管理页面源文案和 v6 历史 Chrome 截图明确写出“网页无法识别未声明身份的 AI 视觉点击”。待发布的 v7 只承诺明确通道请求的管理员手动开关、范围校验、永久撤销、限流和操作记录；不限期不增加可执行权限，也不认证工具品牌。声明式请求头/令牌检查不是 AI 视觉识别，不能阻止已授权人员自行查看或复刻其可见功能。页面、工具标签和本地开关测试不等于已创建真实生产授权、配置品牌客户端或执行业务动作。
