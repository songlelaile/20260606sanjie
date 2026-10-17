> 后续正式 Cursor 已升级到 v2/31918。独立 UAT 实际采用的稳定 baseline 见 docs/uat-creative-evidence-20261001/live-baseline.json：PM2 116 / PID1441390 / restart0，Nginx SHA `5d63ecd0e49b1b72780c12a56eeb2cf5c665e49bc5edb95f03a159dabce08f26`。下面 R51 和第一次 Cursor 快照保留为历史，不能用来回退默认流量。

# 创作工作台测试版部署预检 — 2026-10-01

检查时间使用 Asia/Shanghai。本次只读核对正式站点、ECS Workbench 输出及已下载的生产源码，不停止、重启、替换或迁移生产服务。原 Workbench 的输入被浏览器状态变化阻止后停止操作；随后在主任务授权下建立独立“🧪 作图测试发布”Chrome tab（`1701706142`），免密连接已有实例，完成下文新增只读核查。尚未上传冻结包、创建测试库或启动测试服务。

## 已确认的生产入口

| 项目 | 当前读回结果 |
| --- | --- |
| 实例 | `launch-advisor-20260611` |
| 地域、实例 ID | `cn-hangzhou`、`i-bp13u8781f8dd4lsl75h` |
| 公网、私网 | `47.111.2.10`、`172.16.0.35` |
| 已登录界面 | Chrome 的 ECS Workbench，现有终端 `3. root@iZbp13u8781f8dd4lsl75hZ:~` 状态“已连接” |
| 正式 PM2 | `sanjie-ai1980-tenant-video-r51-v2`，`online` |
| 正式 PM2 标识 | PM2 ID `114`、PID `531554`、重启次数 `0` |
| 正式目录 | `/opt/sanjie-releases/20260925-ai1980-tenant-video-r51-v2` |
| Nginx upstream | `31915` |
| Nginx 配置 | `/etc/nginx/conf.d/sanjie.conf` |
| Nginx 配置 SHA-256 | `40a5a25635764b883b41d8f51209857ec4e9748ff329221e94ad8c124a6db2f2` |
| `/opt` 可用磁盘 | 现有终端输出 `138.95 GiB`；属于本次会话当前读回，部署前需重新核对 |

这些值在独立 Workbench 中通过只读脚本重新读回；Nginx SHA、正式目录、端口及磁盘与原终端输出一致。正式目录没有 Git 元数据，`git rev-parse HEAD` 和 `git status --porcelain` 均返回 `128`，因此不能给出正式 Git SHA，也不能把空 stdout 解释为工作树干净。`.next/BUILD_ID` 存在，当前构建未进行替换。

本机没有 `aliyun` CLI，`~/.aliyun` 不存在。`~/.ssh/config` 只有 GitHub 与通用配置。发现现有私钥文件 `/Users/shaozhuang/Downloads/sanjie.pem`，权限 `0400`；未输出或拷贝私钥内容。下列只读 SSH 入口已尝试，当前本机传输层立即返回 `Can't assign requested address`，尚未进入 SSH 认证：

```sh
ssh -i /Users/shaozhuang/Downloads/sanjie.pem \
  -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes \
  root@47.111.2.10 'hostname; id -u; date -u +%FT%TZ'
```

后续远端工作可复用独立 tab `1701706142` 的已认证 Workbench，无需新建公网 Shell 中转。该 tab 通过既有“免密连接”登录，普通 Bash 可用，File Navigator 已到 `/var/tmp`，可见“上传文件”按钮。原 Workbench tab 归属于历史 browser session，不再输入命令或抢占其焦点。登录启动时 Copilot Shell 可选择“Continue to Bash”，未配置其新认证。

## Cursor 源码与正式源码边界

本地 Cursor 已提交的版本为 `b59de1410eb3cefbb17d01d5f13ce468520a3b56`。当前正式源码归档在服务器 `/var/tmp/cursor-production-source-20261001.tar.gz`，已下载到：

`/Users/shaozhuang/Downloads/cursor-production-source-20261001.tar.gz`

归档共 519 条目、879,786 字节，SHA-256 为 `07daccedcfac36837c283f2fcbb686ad900d596975b9f4111db21c2d2cf942e1`。Workbench 显示生成时间 `2026-10-01 22:40:29`，归档只包含源码、schema、迁移及构建配置，不含 `.env`、私钥或数据库数据。

该归档的经营网络页仍导入 `OperatingNetworkDashboard`、`OperatingNetworkAiPanel`、`ActionComparison`，标题仍为“经营网络・从经营结果到动作验证”。归档里没有 `src/**/creative/`、`creative-*`、billing 或 payment 文件。当前已登录官网管理页的主导航仍有“综合看板、单品突破、人群计划、业务诊断、数据导入、预填写表”。因此本次读取的正式目录和网页仍是数据分析业务，尚未呈现 Cursor 的创作工作台。

| 文件 | 生产归档 SHA-256 | `b59de14` SHA-256 | 是否相同 |
| --- | --- | --- | --- |
| `src/app/dashboards/operating-network/page.tsx` | `d6022fc118398d7b47e824ff4e54605d3cdb2b995101fb462c039bddc5a8e4bc` | `ac5910e1d99cb4928f69b3f93bde6fed6b4ff4ae3d7f1570fec2062637a4055f` | 否 |
| `src/app/api/auth/register/route.ts` | `f357f6a6f0b82bc5b76c0d6dbb4791ed75ef37e17a028583d53c11cddc552fee` | `0d9c5441e7f52d143ba8c3278f8448247c0cdfb5ecd1a9e3e2276d2999e08704` | 否 |
| `src/lib/accounts.ts` | `2d16d60ef373625d1945d50779b93a57db2002dc27a563e9033e98adbf039523` | `7e2d0d05f2bcdb9b22e8f950169a49c6f84e1eef5f8f73865e9370c6cf20d877` | 否 |
| `prisma/schema.prisma` | `479ae0f677923a67a4492370604f1e58aecc12d2eb6d30d4bb4b0fc4e471d5d7` | 同左 | 是 |
| `package.json` | `ba8c15acfe060b9c8e901ae077c12be4bff801ecf5c11e2ce18444a17cd54b93` | 同左 | 是 |

## 配置与数据库

现有 Workbench 脚本只输出配置是否非空，未输出值：

| 配置名 | 是否存在且非空 |
| --- | --- |
| `DATABASE_URL` | 是 |
| `SESSION_SECRET` | 是 |
| `MODEL_GATEWAY_SHAOZHUANG_API_KEY` | 否 |
| `MODEL_GATEWAY_SHAOZHUANG_BASE_URL` | 否 |
| `MODEL_GATEWAY_PAYMENT_PROVIDER` | 是 |
| `MODEL_GATEWAY_MANUAL_PAY_URL` | 否 |
| `VIDEO_ASSET_CONFIG_FILE` | 否 |
| `VIDEO_ASSET_SOURCE_SIGNING_KEY` | 否 |

其他供应商凭据本次未取得当前状态，属未知。仅确认上述配置名是否非空，不输出供应商或数据库凭据值。

生产归档 schema 使用 PostgreSQL，声明了 `ToolEntitlement`、`InviteCode`、`GatewayWallet`、`GatewayApiKey`、`GatewayOrder`、`GatewayUsage`。从正式 `.env` 的 URL 内部识别本地数据库后，通过 `runuser -u postgres -- psql` 只读查询 `_prisma_migrations`，返回 `0`：生产记录的 15 项迁移全部 `finished_at IS NOT NULL=true`、`rolled_back_at IS NOT NULL=false`，包括 `20260701162000_model_gateway`、`20260815001500_tool_entitlements`，最新为 `20260822093000_add_dmp_report_shop`。生产归档和迁移记录均没有本地 `20260830143000_dmp_report_summary_and_pair_indexes`。本次没有执行迁移；所需表/列仍应在部署前核查是否存在手动漂移。

独立测试库创建能力已只读验证：本机 PostgreSQL 管理角色 `postgres` 的 `rolsuper`、`rolcreatedb` 均为 `true`；`sanjie_creative_uat_20261001` 当前不存在。远端 Node `22.22.0`、npm `10.9.4`、psql `15.18` 可用；正式目录的 `node_modules` 存在。`32011`、`32101`、`31925` 本次连接探测均未被占用；建议测试版用 `32011`，启动前再次核验。`/opt/sanjie-test-releases/20261001-creative-uat` 当前不存在。

## 当前匿名 HTTP 结果

2026-10-01 22:41 左右通过本机 `curl` 实测，未附加登录 Cookie。TLS 校验结果均为 `0`。本机网络栈报告远端 `198.18.0.42`，表明存在本机网络映射；本结果是该网络环境下的站点响应，不能声称裸公网 IP 直连成功。`web.open` 本次无法读取这些页面。

| 路径 | 初始响应 | Location / 终点 |
| --- | --- | --- |
| `/login` | 200 | 登录 HTML |
| `/dashboards/operating-network` | 307 | `https://shaozhuangai.com/login` |
| `/models` | 307 | 同上 |
| `/management` | 307 | 同上 |
| `/creative/labs/image-prompt-lab/promptlab.html` | 307 | 跟随 1 次重定向后 `/login` 200 |
| `/creative/labs/ecommerce-video-studio/video-studio.html` | 307 | 跟随 1 次重定向后 `/login` 200 |
| `/dashboards/operating-network?surface=main` | 307 | `https://shaozhuangai.com/login?surface=main`，跟随后 200 |
| `/api/auth/me` | 401 | 匿名未登录 |
| `/api/tools/updates/ai-automation/latest` | 200 | JSON |

创作 HTML 的 307 仅证明匿名认证边界正常，不能证明文件已部署或登录后能用。公开插件 latest 的负载解码版本为 `1.9.80`，返回正文 SHA-256 为 `61bd603b397110fdf8b42fa003b0fc7e8a27a038a41e068f6bc6a45d9dd40207`；本次只做解码与哈希读回，未重新验签，也未验收真实作图/视频供应商调用。

## 测试隔离与复用入口

本次建议先在本机独立 PostgreSQL 数据库与独立端口交付可复核 UAT，再决定是否发布正式站。现有正式 PM2、Nginx、数据库、上传路径和插件历史包保持原状。测试数据库必须用单独 `DATABASE_URL`，测试 `SESSION_SECRET` 单独生成，测试 origin 与端口必须一致；真实收款、模型付费调用、源图上传及生产用户操作不用于 fixture 测试。

可复用的既有只读预检脚本入口（脚本在本机；需要在服务器通过现有认证会话运行）：

```text
/Users/shaozhuang/Desktop/关键词衍生插件/uat-work/r51-tenant-video-assets-20260925/publication/deployment/inspect-live.py
```

脚本仅筛选 Nginx upstream 对应 PM2、输出目录/端口/状态/文件哈希/数据库 provider/配置名布尔状态/公开插件版本与磁盘。不要原样输出 `pm2 jlist` 或完整 `.env`；PM2 原始环境含敏感值。

最少远端只读核对命令可在用户/其他代理不占用终端时执行：

```sh
python3 /实际已上传路径/inspect-live.py
```

远端 UAT 应建立新的 `/opt/sanjie-test-releases/20261001-creative-uat`，只在再次核验空闲的本机端口 `32011` 启动独立 PM2，接独立测试数据库 `sanjie_creative_uat_20261001`；不替换 Nginx upstream、不复用正式 Cookie 密钥、不从测试账号读写正式业务数据。依赖从当前正式目录用 `cp -a --reflink=auto` 复制到测试目录，避免通过 `node_modules` symlink 后执行 Prisma generate 改写正式依赖。主任务提供冻结包及 SHA 后才开始上传、创建测试库、构建和启动。完成测试后保留封存包、哈希、验收回执及现有正式发布的回滚入口。
# 独立 UAT 发布前再次核对

2026-10-01 后续独立 Workbench 只读快照发现 Cursor 并行部署已改变默认正式 upstream。以下为本次 UAT 应保留的新基准，早先 R51 快照只代表当时状态：

- `/etc/nginx/conf.d/sanjie.conf` SHA256：`54facf4d6f82dbe28f2790b93bd40eee8532dc476a9f5f30723b38570fb80073`。
- HTTPS server 中三个代理位置均为 `127.0.0.1:31916`；`/media/tutorials/` 静态 alias 与显式 `proxy_redirect` 保持原规则。
- 新正式 PM2 `sanjie-cursor-20261001`，pm_id 115，PID 1435977，cwd `/opt/sanjie-releases/20261001-cursor-b59de14`，PORT 31916，online，restart 0。
- 旧 R51 PM2 114 / PID 531554 / 31915 仍在线，但已经不是默认 upstream。UAT 不应把默认流量回退到它。
- 独立 UAT release 仍不存在，尚未执行数据库/服务/Nginx 发布操作。
- 根冻结包最终 SHA256：`99d5db3187a5deeb68527d6d9165f514bc0ee8ab662c2db5e5a17fcf75217999`，2,209,534 bytes。旧 SHA `863644…` 未上传或运行。

## 独立测试版最终回读（2026-10-02 00:22:16）

以上均为发布前历史快照，截图手工转录SHA不得作为当前操作基准。最终官方Workbench下载证据为 `docs/uat-creative-evidence-20261001/public-final.json`，详细发布记录为 `docs/uat-creative-public-20261001.md`。

测试入口已上线 `/uat/creative-20261001`，退出 `/uat/creative-exit`。当前独立测试PM2 120/PID1454541、127.0.0.1:32011、数据库 `sanjie_creative_uat_20261001`。当前正式默认为31919（`sanjie-studio-genesis-20261001-v1`，PM2 122/PID1461159，cwd `/opt/sanjie-releases/20261001-studio-genesis-v1`），保留并行新正式，不回退任何历史版本。Nginx当前SHA256 `7365bc58f5aa321e8114e9fd59b37f12ffeebbfbe26bf26bd404249231f5c701`。

最终静态修正包SHA256 `ad59112b9b741ff3eba03acba089fc63d15f46ff5766dd5df5d9980b5a49a6ab`，494源码全部匹配，只有2个静态JS+1个测试改变。原build `Z3paCEiAnyMhDNqoUZ1Gb`保留，最后补丁未重启或构建。最新8条PM2持久化内容与复活配置匹配，原dump/.bak字节保留、权限0600，启用的有效startup unit正确；没有执行pm2 save或实际重启模拟。
