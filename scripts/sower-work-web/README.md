# Sower Work 网页运行服务

此服务把独立云端 Sower Work 接到网站 `/sower-work/app/`。网站页面负责导航；本服务负责网页、HTTP、上传、文件流和 WebSocket。它不打开、重启或修改现有桌面客户端，也不导入桌面历史、登录、模型密钥或运行目录。

每个请求都只把网站 Cookie 交给配置的本机 `/api/sower-work/access`，该接口必须实时查库并返回 `{allowed:true,userId,userName,tenantId}`。不信任客户端用户头。每个管理账号映射到独立控制账号、工作区和内部会话；随机密码与内部会话不进入浏览器。写请求必须携带真实网站同源 Origin；进入控制服务前再设置其本机 Host、Origin、Cookie 和 CSRF。已经连接的 WebSocket 每 30 秒重验授权，撤销后关闭。

`/sower-work/app/_bridge-status` 需管理账号，只有引擎 `/health` 当前成功才报告 ready；同时返回未启用的桌面 CDP 和多模态桥能力。独立云端模型尚需管理员在工作台配置，部署与验收均不发送模型请求。

## 打包与部署

1. 使用独立源副本构建最新 renderer，勿在正在使用的客户端目录重新打包。将产物传给 `--renderer`。
2. `node scripts/sower-work-web/prepare.mjs --source /path/to/SowerWork --renderer /path/to/verified/out/renderer --output /path/to/new/release`
3. 把完整 Linux x64 AionCore **v0.2.2** bundle 放入 release 的 `resources/bundled-aioncore/linux-x64/`：需 `aioncore` 与 `managed-resources/manifest.json`。官方 archive 若只有 binary，在独立云端临时目录运行该 binary 的 `--data-dir /absolute/temporary prepare-managed-resources --bundle-out /absolute/release/resources/bundled-aioncore/linux-x64/managed-resources`，再校验 Node 24、manifest 和资源权限。不能复用 macOS binary；不能只放一个可执行文件。
4. 在新 release 中安装清单声明的依赖。以独立无登录 shell 的 `sower-web` 系统账号运行，release 只读，`/var/lib/sower-work-web` 归该账号；Linux root 启动会被拒绝。`NODE_BINARY` 取完整 Linux bundle 的 managed Node 24 的绝对路径，启动：`"$NODE_BINARY" --import tsx runtime/runtime.mjs`。
5. 设置 `SOWER_WEB_RUNTIME_DIR=/var/lib/sower-work-web`（持久化）；`SOWER_WEB_PUBLIC_ORIGIN=https://shaozhuangai.com`（仅接受这个规范 HTTPS origin）；`SOWER_WEB_ACCESS_URL=http://127.0.0.1:32151/api/sower-work/access`（只读网站授权服务）；`SOWER_WEB_PORT=32150`。只有 loopback 可以接触桥、控制服务与引擎，`www` 由网站跳到主站。
6. Nginx 将 `/sower-work/app/` 原样转到桥，保留外部 Origin，支持 Upgrade，关闭 proxy buffering，禁用缓存；不能直接公开 control 或 engine port。桥会验证网站权限，不依赖 Nginx 用户身份头。

打包输出保留源码和 renderer 哈希证据，脚本只读取原目录，并只复制随源码发布的 `resources/builtin-assistants`，通过引擎环境变量加载 Sower Work 助手品牌。可选 `--bundle /path/to/full/linux-x64` 把已经验证的 Linux bundle 放入新 release。当前本机旧 Desktop `out/renderer` 为 2026-09-21，运行 candidate-r3 为 2026-09-25，均不是 2026-10-01 源码的最新构建。

## 验证

`node --test scripts/sower-work-web/bridge.test.mjs` 验证拒绝普通账号、同源写请求、客户端身份伪造隔离、请求路径及流式透传、prefix 注入和授权服务失败。实际部署还必须验证管理员进入、普通账号拒绝、上传/图片流、WebSocket 101、工作区读取及现有桌面进程保留。无需发送模型消息。

`SOWER_CONTROL_SOURCE=/absolute/release/vendor/packages/sower-control node --import tsx --test scripts/sower-work-web/identity.test.mjs` 在临时新数据库验证真实 ControlStore 的用户/租户隔离、撤销和重新授权；未提供源路径会明确 skip，不能算通过。

`live-runtime.test.mjs` 使用明确指定的独立 release、本机完整 engine bundle 与依赖目录，启动临时云运行服务及 fixture 网站授权服务；验证真实引擎身份、助手、provider CRUD、WS、上传和图片流。fixtures 的 localhost provider 不允许任何网络调用，也不发送消息。云端桥对本地文件额外检查账号根目录、上传归属、symlink/traversal 和 multipart 会话归属，弥补上游原始绝对路径文件接口的跨账号读取缺口。

这些账号隔离检查覆盖网页 HTTP、文件与配置接口及 WebSocket；引擎执行和 shell 工具仍使用同一个 `sower-web` 系统账号，没有按网站账号建立操作系统沙箱。当前验收未执行模型或 shell 任务，不能据此宣称这些任务具备强租户文件隔离。

## 第一批可迁移能力（0.2.0）

网站新增三个入口：对话与智能体、关键词与知识库、长详情编辑。后两个使用单独的网页模块，不依赖桌面 CDP、多模态任务或平台登录。长详情支持已有图片导入、顺序/标题/宽度编辑、保存以及 PNG/切片 ZIP；重操作限制为每账号同时 1 个、全局 2 个、每分钟 6 次。关键词支持 CSV/标准 JSON 导入、保留原件及来源、去重、人工词根和同范围完整市场原表生成规则草稿；文本知识文件支持保存与字面检索，待解析文件会明确标注。它们不会调用模型或扣积分。

主页面通过 `/api/sower-work/credits`、`/api/sower-work/credits/ledger` 只读现有 SaaS 钱包。管理权限、账号和租户来自服务端验证后的会话，客户端不得选择账本归属。SW 独立充值、回调和旧积分写入已在桥接层阻断。此批只展示共享余额，并不把 SW 对话和任务接入套餐扣费；统一预占、结算、退款及旧余额迁移仍待实施。

健康接口仅证明引擎在线。父页面另要求实际 renderer/便携页面通过来源、窗口和随机 token 校验的加载消息；25 秒未收到会显示工作区加载失败。`www` 网站入口跳回规范域名；桥仍拒绝非规范 Host。

`prepare.mjs` 固定已测的直接依赖版本，并输出每个运行文件的大小及 SHA-256 清单。此清单不代表已安装 Linux 依赖、已上线或已验收真实浏览器；发布前须重新读取当前服务器版本、做最小差异 canary，并保留回滚路径。
