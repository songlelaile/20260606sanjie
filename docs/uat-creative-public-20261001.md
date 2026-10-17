# 作图视频独立测试版发布验收（2026-10-01）

状态：独立测试入口已上线，服务器构建和 12 项公网路由检查通过；实际公网自主注册/未付费流程 23 项、受邀作图/视频交互23项全部通过，JavaScript pageerror 为 0。PM2 持久化已安全核验。取消 API 配置提示的三文件静态补丁已精准应用，全部494源码与新封包一致，新增取消交互公网复验已通过，合计46项全部通过。

## 冻结与隔离边界

- 初次构建源码包 SHA256：`99d5db3187a5deeb68527d6d9165f514bc0ee8ab662c2db5e5a17fcf75217999`，2,209,534 bytes。最后静态修正包 SHA256：`ad59112b9b741ff3eba03acba089fc63d15f46ff5766dd5df5d9980b5a49a6ab`，2,094,853 bytes；494文件中只改两个静态JS和一个测试，其余491原文保留。
- 本次代码来自根审定的 R51 基底加创意工作台、支付、网关和自主注册范围。根已记录 977 测试、lint、typecheck、production build 通过，实际公网部署另行核对。
- 初次正式基准为 `sanjie-cursor-20261001-v2`，cwd `/opt/sanjie-releases/20261001-cursor-b59de14-v2`，31918，pm_id 116，PID 1441390，restart 0。并行 Cursor 随后发布新正式 `sanjie-creative-tools-20261001-r2`，cwd `/opt/sanjie-releases/20261001-creative-tools-r2`，默认 31917，pm_id 119，PID 1452136，restart 0；再随后发布 `sanjie-management-removal-20261001`，cwd `/opt/sanjie-releases/20261001-management-module-removal-v5`，默认 31921，pm_id 121，PID 1456407，restart 0。最后并行正式为 `sanjie-studio-genesis-20261001-v1`，cwd `/opt/sanjie-releases/20261001-studio-genesis-v1`，默认31919，pm_id122、PID1461159、restart0。已顺应保留最新正式默认31919，没有恢复旧版本或混入最新Genesis业务源码。
- Nginx 发布前 SHA256：`5d63ecd0e49b1b72780c12a56eeb2cf5c665e49bc5edb95f03a159dabce08f26`。
- 测试目录 `/opt/sanjie-test-releases/20261001-creative-uat`；PM2 `sanjie-creative-uat-20261001`；127.0.0.1:32011。
- 独立 PostgreSQL DB `sanjie_creative_uat_20261001`。仅复制一个有效平台 admin 的身份和既有 scrypt 密码 hash，新测试 tenant；不复制业务表数据或模型 key。
- 全新 SESSION/SHARE/AI encryption secret；测试 cookie 名独立且 host-only；TZ=Asia/Shanghai；测试 relay 私有目录独立；manual 支付，无真实收款 URL、上游 key。
- 初次正式 v2 的 public/private-assets/node_modules 复制到独立目录，node_modules 不是 symlink；R51 缺失旧资产仅补齐、不覆盖同名文件。测试复制品 public/creative 与 creative-tools 由冻结包完整重建，防止 Cursor 后发布改动混入；维修没有重新复制后续正式资产。
- 入口 `/uat/creative-20261001` 设置路由 cookie；退出 `/uat/creative-exit` 只清测试 cookie。默认 upstream 从初始 31918 顺应并行正式更新为当前31919，测试端口始终 32011。
- UAT fetch/XHR 同源 marker 为 `creative-20261001`；marker 配错或缺路由 cookie 时 Nginx 409，入口/退出明确除外。旧 UAT tab 退出后不能借正式 session 写正式 API。

## 发布工具与恢复

- runner：`scripts/deploy-creative-uat-20261001.py`，阶段 prepare/check/canary/route/verify/rollback/status/repair-runtime。
- runner 的 20 项 Python 单测通过：tar 路径与秘密过滤、冻结 SHA、隔离抽取、路由默认保留、marker mismatch、原 URI/重定向与安全头继承、回滚校验失败和并发编辑防覆盖、历史文件仅补缺与幂等、登录跳转同源校验，以及禁止旧备份覆盖并行新正式。
- Nginx 变更先做带 SHA 的备份，CAS 检查当前原始 SHA；atomic replace 后 nginx -t，失败或公网边界检查失败执行受 CAS 保护的回滚。不会覆盖并行修改。
- 并行正式更新后，历史 Nginx 备份不能用于回滚：runner 已设置 `rollback_requires_fresh_review=true`，旧 rollback 命令会拒绝执行，防止把默认恢复到 31918。退出测试可直接访问 `/uat/creative-exit`；撤销服务时先只停止测试 PM2，保留 marker 拒绝规则，避免旧测试 tab 转而写正式 API。测试数据库与目录保留供审计，正式进程不重启。

## 保留 AI 工具

2026-10-01 独立 Workbench 读取当前 Cursor 与 R51 均为相同工具 metadata v1.9.80。元数据位于 `src/app/tools/page.tsx`。

|公开文件|当前正式 bytes|R51 bytes|
|---|---:|---:|
|`/downloads/sycm-keyword-collector-v1.9.80.zip`|6,593,181|6,593,181|
|`/downloads/shaozhuang-ai-v1.9.80-macos-full.zip`|213,896,775|213,896,775|
|`/downloads/shaozhuang-ai-legacy-icon.png`|2,348|2,348|

发布时还核对复制后的插件 ZIP 内 manifest 版本和公开下载 HEAD 大小。磁盘文件存在不等同插件实际安装/升级验收。

## 实际服务器与公网结果

prepare 回读成功：独立测试目录和 DB 创建、Prisma generate + db push 成功，一个平台 admin + 新测试 tenant 初始化完成。生产 PM2 身份与原 Nginx 配置守卫通过，未调用 provider 或真实支付。

实际 snapshot 已通过官方 Workbench 下载并保存在 `docs/uat-creative-evidence-20261001/live-baseline.json`。截图手工转录的旧 SHA 有 a/d 混淆，最终证据使用下载文件原文，不再依赖 OCR。

初始化曾因 GNU cp 9.4 的 cp -an 补缺返回非0停止；当时 DB 尚未创建，全部正式服务保留。已改为逐个仅复制缺失文件，并在同冻结 SHA、phase=preparing、无 DB 的测试目录里续跑成功。

服务器 typecheck + production build 通过，build ID `Z3paCEiAnyMhDNqoUZ1Gb`；构建后及发布后均验证 494 个冻结源码文件内容与清单一致。

loopback canary 和公网 12 项检查通过：默认 `/login` 200 且不含测试标记；测试路由登录页 200；缺/错误 cookie 带 UAT marker 的 API 与 `_next` 请求 409；正确组合匿名 auth 401；入口/退出 302 同源 `/login`；三个保留工具下载 HEAD 200 且大小与元数据一致。

PM2 UAT 修复后 `pm_id=120`、PID 1454541、restart 0，以 `clean_environment(read_env(RELEASE))` 显式传入全部独立配置。仅输出布尔比对结果：`.env` 完全一致、生产 secrets 未复用、无意外 provider key。原 114/115/116 进程均在线、原 PID 与 restart 0 保留；原 113 的 stopped 状态也保留。

最新脱敏服务器证据于 2026-10-02 00:22:16（UTC 16:22:16）经官方 Workbench 下载到 `docs/uat-creative-evidence-20261001/public-final.json`，包含入口、历史与当前正式基准、Nginx SHA、冻结清单 SHA、完整检查结果和管理账号 seed 证据。`.env` 为 0600，relay 私有目录为 0700，relay 配置文件不存在。先前 `public-state.json` 和 `public-state-final.json` 保留为维修前与正式默认31917的历史证据；`public-final-prepatch.json` 保留为正式默认31921、首次7条持久化核验的静态补丁前历史。

Nginx 当前配置 SHA256：`7365bc58f5aa321e8114e9fd59b37f12ffeebbfbe26bf26bd404249231f5c701`。初次测试路由 SHA `86bc6fc53b29371ed9aab4a6f9d1983045ba54526f2be762ccfb596eb8eddf9b` 与备份 `/etc/nginx/conf.d/sanjie.conf.pre-creative-uat-20261001-1790868594` 仅保留为历史。维修逐一精确检查现有五个 map（仅 default 端口允许顺应正式更新）、入口/退出块和全局 409/cache 保护，然后采用原始最新 SHA；没有写 Nginx。

首次路由验证对相对 Location 断言过严，Nginx 正常返回 `https://shaozhuangai.com/login` 时触发自动 CAS 回滚。改为严格同源 URL 等价校验并新增测试后重新安装通过；错误 origin/path/query/protocol 仍拒绝。

实际 Chrome 完整显示作图/视频登录页和三个注册/登录选项；点击自主注册一次即可出现姓名、手机号与密码表单。退出测试入口后原正式管理员 session 仍有效。未用该 Chrome 表单提交账号、生成任务或支付。

真实新注册测试账号的后续浏览器验收曾发现 `/creative/labs/...html` 返回 500，但同文件 `/api/creative/assets/...html` 正确返回 402。UAT error log 明确显示 `Failed to proxy https://localhost:32011/api/creative/assets/...` 与 `EPROTO: wrong version number`。实际 Next 15.3.3 源码与 Node 重现确认：NextURL 将 127.0.0.1 规范成 localhost，initURL 仍取启动 hostname；两者 origin 不同令内部 rewrite 变成错误 TLS 外部代理。

只调整 UAT 启动为 `--hostname localhost` 并显式 `NODE_OPTIONS=--dns-result-order=ipv4first`；预先 DNS 断言 localhost 解析为 127.0.0.1，启动后 ss 断言唯一 listener 为 127.0.0.1:32011 且归属测试 PID，source494/hash、隔离 env 与正式身份仍符合。业务源码与冻结包不变，服务器 12 项再次通过；实际登录后 402/200、iframe 和工作台交互已通过根公网流程复验。

为覆盖受邀已授权 HTML 200 路径，仅在已断言名称的独立 DB 创建一次性测试邀请码，tenant=测试 admin、createdBy=admin、maxUses=1、备注明确公网 QA，同源 registrationUrl。代码值只交付到包外私有文件（0600），不写本文、不修改客户/原 DB，不触发生成和真实支付。

公网浏览器证据保存在 `.codex-deploy/creative-uat-20261001/browser/public-browser-acceptance.json`（23/23）和 `public-invited-browser-acceptance.json`（23/23）：真实自主注册和登录、未付费402门禁、测试库待审核 manual 订单、普通用户不能确认付款、退出后旧测试页409、一次性受邀注册、五个作图模式、三种视频模式真实 aria-selected 切换、API 设置打开/取消、六个授权 HTML 200 均通过。邀请码已消耗一次；未调用真实 provider、未实际付款。API 配置取消的错误 toast 已完成最后静态修正，新增公网取消检查已通过：取消保留凭据、不保存修改、不产生错误toast。

PM2 持久化已完成有据安全核验：并行正式发布者此前已保存当前八条目，其中包括 stopped collector 和正确的 UAT localhost/ipv4first 启动配置。本次没有调用 `pm2 save`；全部原 dump 条目与当前进程复活配置/env/args逐字段一致（只排除动态 `axm_monitor` 运行遥测），原 dump 与 .bak bytes 均未改变，既有 PID/restart 全保留。先在 `/root/.pm2/creative-uat-private-backups/1790871689979051157` 留下私有原件备份，再以原始 bytes CAS 守卫将原 dump 与 .bak 权限改为0600。

有效 `pm2-root.service` 已 enabled 且 active，User=root、PM2_HOME=/root/.pm2、ExecStart 指向 `/usr/local/lib/node_modules/pm2/bin/pm2 resurrect`。这证明当前开机恢复配置和快照包含测试服务；没有重启或执行 resurrect 模拟，不将配置验证冒充实际重启验收。`scripts/persist-creative-uat-20261001.py` 当前仅验证、备份、收紧私有文件权限，4 项 Python 单测通过。完整脱敏 proof 位于 `public-final.json` 的 persistence 字段，最后读取时间UTC 2026-10-01T16:21:30Z；旧7条/16:02:42证明完整留在persistence_history。当前dump SHA256为 `880261007a21a7d1ffe7e4da17c6c71713bd727de82deebc6ae06c367e94a670`、.bak SHA256为 `555522e34c34a5f8b7dec6419c85ffd9c53cafbb5b8a16eff25561be2bf79dcc`，本次核验期间byte均未变化。

## 最后静态补丁实际结果

根冻结的新包 SHA256 为 `ad59112b9b741ff3eba03acba089fc63d15f46ff5766dd5df5d9980b5a49a6ab`（2,094,853 bytes）。精确更改 `public/creative/web-video-host.js`、`public/creative/labs/ecommerce-video-studio/video-studio.js` 与 `src/lib/creative-web.test.ts`；其余491文件逐项来自原封包。`scripts/patch-creative-uat-static-20261001.py` 已通过11项安全测试和独立复核，使用安全临时文件/CAS，proof也在可回滚事务内。官方上传一度返回 INTERNAL_SERVER_ERROR，刷新专属会话后恢复；原包和新v2包保留为不同文件。UTC 2026-10-01T16:20:49Z已实际成功应用，receipt位于最终proof的static_patch_receipt/static_patch_history。全部494文件match新tar，新manifest SHA256为 `707d3ad36cf54d9c328c7f3cdbc53bbb5d4e9ac505b53ec7e6df4bdf201de477`。UAT仍pm_id120/PID1454541/restart0、build ID仍 `Z3paCEiAnyMhDNqoUZ1Gb`；全部正式PID/restart、Nginx原始bytes、PM2 dump/.bak、测试env和build在补丁前后稳定。没有prepare、重新build、重启、save或DB操作。只修改teststate记录最新正式31919及历史，并以原state字节CAS写入同一可回滚事务。

旧v1、新v2源码tar均保留服务器。3文件、state、manifest私有原件备份在 `/opt/sanjie-test-releases/20261001-creative-uat/static-patch-backups/1790871649956819018`。补丁应用器最终SHA256为 `144dd176c962b97be4781cdba17a37264fc9b736be8f70f095876d9f9d35d366`，11项安全测试和独立动态基准模拟5项断言通过。正式31921硬编码守卫曾正确拦住并行31919更新，未修改任何源码；改为精确验证现存五map/入口/409与独立正式身份，在内存采用fresh baseline，再进入同一CAS事务。旧测试页面需要刷新才能加载新静态JS。

根最后以真实受邀认证HTTPS GET核对两个静态JS响应SHA与新包逐字节相同，证据为 `docs/uat-creative-evidence-20261001/public-static-hashes.json`（UTC16:24:29.464Z、authenticated=true、2checks/pass=true）。公网非受邀23+受邀23共46项全通过、pageerror0；真实截图确认中性取消toast，无配置保存或供应商调用。根已复核public-final新SHA、494一致、fresh持久化8条与正式-v1身份，服务工作正式收口。
