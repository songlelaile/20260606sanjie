# 三阶报告恢复验收记录（2026-10-02）

本轮已恢复「三阶报告」主导航和原有报表、经营分析、数据管理二级功能，并于北京时间 2026-10-02 01:58:50 正式上线。主导航按后续要求位于「视频创作」之后，二级工作台沿用图像创作的侧栏、工具栏和内容区布局。源码、定向 UI、隔离本机数据库闭环、服务器 production build、29 项 canary、29 项公网检查及正式已登录浏览器 11 页导航验收均已完成。根工作区并行修改造成的全量检查失败仍单独如实保留。

## 已完成的页面与路由

| 权限 | 二级功能 | 路由 | 本机 HTTP 结果 |
| --- | --- | --- | --- |
| tenant / admin | 综合看板（第一张报表） | `/dashboards/management` | 200，包含三阶报告工作台 |
| tenant / admin | 单品突破（第二张报表） | `/dashboards/product-breakthrough` | 200，包含三阶报告工作台 |
| tenant / admin | 人群计划（第三张报表） | `/dashboards/audience-plan` | 200，包含三阶报告工作台 |
| tenant / admin | 经营网络 | `/reports/operating-network` | 200，包含旧仪表盘、动作验证和 AI 面板 |
| tenant / admin | 业务诊断 | `/dashboards/business-diagnosis` | 200，包含三阶报告工作台 |
| tenant / admin | 数据导入 | `/imports` | 200，包含三阶报告工作台 |
| tenant / admin | 预填写表 | `/prefill` | 200，包含三阶报告工作台 |
| admin | 工作区概览 | `/admin` | admin 200；tenant 307 回角色首页 |
| admin | 版本留痕 | `/versions` | admin 200；tenant 307 回角色首页 |

原有三张报表、业务诊断、导入和预填写的路由保持。旧经营网络源于 `b59de14^:src/app/dashboards/operating-network/page.tsx`，迁至新 `/reports/operating-network`，保留当前 `/dashboards/operating-network` 图像创作和其 `/video` 视频创作页面。

入口及别名已验证：`/reports` → `/dashboards/management`；`/dashboards/diagnostics` → `/reports/operating-network`；不存在的旧 `/dashboards/product-opportunity` → `/dashboards/product-breakthrough`。已移除把报表、数据导入、预填写强制跳转图像创作的配置。tenant 和 admin 的路由权限均包含 `/reports`，管理留痕二级入口仅向 admin 显示。

Next dev 中 diagnostics 经异步父布局流式返回 200，响应同时含精确指向 `/reports/operating-network` 的 meta refresh 与 `NEXT_REDIRECT;replace;…;307;` 标记；本机验收记录明确区分此机制和普通 HTTP 307 Location。

## 定向 UI 与本机数据验收

定向 UI 测试使用真实 `AppShell` 的 React SSR，mock `usePathname` 和 `ShopSwitcher`。执行 `node_modules/.bin/vitest run --config src/components/reports/vitest-ui.config.ts`，1 个测试文件、13 项通过。覆盖模型网关后的报告入口、三张报表及其他旧功能的主导航和唯一二级高亮、导入子路径、图像/视频独立工作台、相似前缀边界和 tenant/admin 的管理留痕可见性。新增 UI 测试定向 lint 通过；根任务随后将 props 类型断言适配 TypeScript，并为报表 KPI 标签加入限定作用域的换行样式。

本机 preview 位于 `.codex-deploy/sanjie-reports-20261002/preview`，验收时服务为 `http://localhost:32117`，现已停止。使用 `scripts/payment-uat-db.mjs` 的 `createPaymentUatDatabase` 新建本机随机 schema `payment_uat_1790876815109_f235d9af72`，没有改写既有 schema 或业务行。preview 的 `.env.local` 只配置隔离数据库、随机会话密钥、独立 cookie、测试标识和本机 origin；没有复制根环境的供应商 key。测试账号包括 tenant、admin 和第二个独立 tenant，账号文件与 `.env.local` 均为 0600；密码、会话 cookie 和数据库 URL 不写入验收记录。

HTTP 验收共 44 项通过、0 项失败，脱敏机器记录见 [本机 HTTP 样例验收](uat-sanjie-reports-evidence-20261002/local-http-acceptance.json)，执行脚本为 `.codex-deploy/sanjie-reports-20261002/http-acceptance.mts`。验收完成于北京时间 2026-10-02 01:49 左右，包含：

- 匿名访问 7 个 tenant 页面均跳登录；三张报表 API 和导入写接口均返回 401。
- tenant 的 7 个二级页面均为 200，响应 HTML 包含报告工作台；入口和旧别名指向正确目标。
- tenant 访问 `/admin`、`/versions` 被重定向；admin 可访问两页。
- 四源样例分别通过 mapped DTO 复验并 POST `/api/import-batches/ingest`，每源 3 行、201，服务端记录为 validated。
- 初次计算派生预填写占位，随后 PATCH 3 个商品参数，再 POST `/api/calc-runs`，返回投资 3 行、突破 3 行、人群 3 行。
- 三张报表 API 均返回 200 和 3 行计算结果；综合报表实际分析周期为 2026-10-01 至 2026-10-01。
- 第二个独立 tenant 的三张报表 API 均为空，且响应不包含样例商品 ID。
- 计算后的三张报表 HTML 均可见 `[验收样例]` 标识。

上述数据来自 `golden-scenario` fixture 每源前三行，日期改为 2026-10-01，名称显式加 `[验收样例]`。这是隔离本机的样例导入与计算，并非真实店铺的新数据导入，也不证明真实店铺采集。HTTP 流程直接提交经校验的映射 DTO，尚不构成浏览器上传 XLSX/CSV 解析及导出操作的验收。本轮该验收未调用供应商、未支付、未发布。正式验收完成后仅停止本轮测试 launcher 及其 Next server，隔离 schema 和测试文件保留以便复现；未删除业务数据或任何 schema。HTTP 记录中的 `serverLeftRunning: true` 表示当时完成 HTTP 验收的状态，不表示服务现在仍运行。

## 根工作区检查与正式候选

根工作区全量发布检查未通过，不能将源码编译成功称为完整 build 成功：

| 检查 | 当前结果 | 已知证据 |
| --- | --- | --- |
| 根工作区 typecheck | 通过 | `predeploy-full.log` 中 `tsc --noEmit` 完成 |
| 根工作区 lint / full predeploy | 未通过 | 并行新增 `src/lib/studio-entry-startup.test.ts:65:11` 触发 `@typescript-eslint/no-this-alias` |
| 根工作区全量 Vitest | 未通过 | 109 文件通过、1 文件失败、2 文件跳过；1150 项通过、3 项失败、17 项跳过。`creative-image-runtime.test.ts` 三项因 `MutationObserver is not defined` 失败 |
| 根工作区 Next build | 未通过 | `Compiled successfully in 7.7s` 后在上述 lint 错误处退出 |
| 发布工具测试 | 通过 | 本轮精确 overlay 发布器的 36 项测试通过，覆盖固定范围与拒绝越界等发布保护 |
| 服务器正式候选定向 tests / 报告 UI / typecheck | 通过 | 发布 receipt 记录各自服务器日志，见下文 |
| 服务器正式候选 production build | 通过 | Build ID `E-6_BFXJSbn3xoNfv6N1R`，候选已正式运行 |
| Canary / 公网发布检查 | 通过 | 29 项 canary、29 项公网检查通过，phase 为 `published` |
| 正式已登录浏览器验收 | 通过 | 实际导航点击 7 报告页、2 管理留痕页、2 创作页，正确标题与高亮；浏览器 logs 为空 |

正式候选按根任务读取的在线基准 `/opt/sanjie-releases/20261002-studio-layout-v1`（进程名 `sanjie-studio-layout-20261002-v1`、默认端口 31925）构建，以在线原件为基底，仅覆盖 14 个已审阅文件。该读回基准保存在 `.codex-deploy/sanjie-reports-20261002/live-baseline-readback.json`；它是本轮读回快照，不替代切换前的最新线上状态检查。

14 文件范围为 `next.config.mjs`、`src/components/AppShell.tsx`、`src/components/PrefillEditor.tsx`、`src/app/globals.css`、`src/app/layout.tsx`、`src/lib/auth.ts`、`src/app/dashboards/diagnostics/page.tsx`，以及新建的 `src/app/reports/page.tsx`、`src/app/reports/operating-network/page.tsx`、`src/lib/sanjie-report-navigation.ts`、`src/components/reports/SanjieReportWorkspace.tsx`、其 CSS、UI 测试与独立 UI 配置。未将根工作区所有未提交修改整体带入候选，也未将根工作区全量失败标成通过。

最终封包 receipt 保存于 `.codex-deploy/sanjie-reports-20261002/bundle-receipt.json`，包为 58,890 字节、SHA-256 `33017e500297f5772d4dc212f9d8f6c1446e0d11f341fbc252153be168178fbe`。发布记录确认 manifest SHA-256 `9d4d5358323f3ae487d06dae8b94dac6b72eeda58a615d0df4b08c09f9b32951`、runner SHA-256 `46999488392f9e7d3a44677d35ac96350084671525df51fd2fa9689d920c7bcf`。根工作区失败日志为同目录 `predeploy-full.log`、`tests-full.log`、`build-full.log`。

## 正式发布与公网验收

脱敏记录见 [正式发布证据](uat-sanjie-reports-evidence-20261002/publication-evidence.json)，`phase: published`，发布时间 UTC `2026-10-01T17:58:50.450353+00:00`，对应北京时间 2026-10-02 01:58:50。正式进程 `sanjie-reports-20261002-v1`，PID 1480374，状态 online，目录 `/opt/sanjie-releases/20261002-sanjie-reports-v1`，端口 31929，build ID `E-6_BFXJSbn3xoNfv6N1R`。切换后 Nginx SHA-256 为 `0632e0d432ce25f60d24e09582114e2d6c3a7011ebe29ad9934365408c06732b`。

服务器验证日志均位于正式目录的 `deployment-logs/sanjie-reports-20261002/`：

- `targeted-tests-1790877231601776463.log`
- `report-ui-tests-1790877238992998988.log`
- `typecheck-1790877240470300415.log`
- `build-1790877261773272131.log`

29 项 canary 和 29 项公网检查通过。公网匿名登录页 200，报表与现有受保护页面跳登录，受保护 API 返回 401；原有三项下载资源 HEAD 200、Content-Length 与原字节数一致，服务器基准与候选文件清单中的 SHA-256 一致；AI automation update 端点 GET 200、实体 SHA-256 `61bd603b397110fdf8b42fa003b0fc7e8a27a038a41e068f6bc6a45d9dd40207` 与原签名文件一致。发布保留原环境、运行时和 node_modules，未迁移数据库、未调用供应商；10 个旧进程保留，摘要读回中原基准进程仍 online（PID 1469958、31925）。回滚 Nginx 原件为 `/etc/nginx/conf.d/sanjie.conf.pre-20261002-sanjie-reports-v1`。

记录见 [正式已登录浏览器验收](uat-sanjie-reports-evidence-20261002/public-browser-acceptance.json)，origin 为 `https://shaozhuangai.com`，标明 `readOnlyProduction: true`、`sampleDataOnly: false`。每一页通过实际主/二级导航点击进入；9 个报告和管理留痕页面等待对应 h1 后读取主导航、二级高亮和当前店铺，2 个创作页面读取工作台、iframe 与实际加载界面。

| 正式浏览器页面 | 已确认行为 |
| --- | --- |
| 综合看板 | h1「盈利分层诊断・先看利润证据，再过投资闸门」，三阶报告 / 综合看板高亮 |
| 单品突破 | 对应单品八步诊断 h1，三阶报告 / 单品突破高亮 |
| 人群计划 | 对应人群三收计划 h1，三阶报告 / 人群计划高亮 |
| 经营网络 | 对应经营网络 h1，三阶报告 / 经营网络高亮 |
| 业务诊断 | 对应业务诊断 h1，三阶报告 / 业务诊断高亮 |
| 数据导入 | h1「源数据」，三阶报告 / 数据导入高亮 |
| 预填写表 | h1「预填写表」，三阶报告 / 预填写表高亮 |
| 管理员工作区概览 | h1「管理后台」，三阶报告 / 工作区概览高亮 |
| 管理员版本留痕 | h1「版本留痕」，三阶报告 / 版本留痕高亮 |
| 图像创作 | 图像创作主入口高亮，仍为创作工作台；主图 iframe 正确，无报告 workspace |
| 视频创作 | 视频创作主入口高亮，仍为创作工作台；视频 iframe 正确，无报告 workspace |

9 个报告/管理留痕页面均保持原店铺 ID `shop-01b7276bf432670b`，当前店铺名「西西礼」，原有登录保留。9 页读回的 viewport 与页面宽度均为 2560，没有横向溢出；浏览器验收 `logs` 为空。[正式综合看板截图](uat-sanjie-reports-evidence-20261002/public-reports.png) 可见模型网关后的「三阶报告」、对应二级栏、当前店铺及报表内容区。

当前三张报表为空。版本页历史明确列出 2026/08/25「清空源数据」，本轮只记录该历史状态，没有恢复旧历史快照覆盖现有数据。正式页面与导航恢复已验证；空表不被填入本机样例，也不据此声称真实经营数据已经恢复。

生产验收全程只读，未实际上传文件、保存预填写或重新计算；这些写入闭环已在隔离本机通过 44 项 HTTP 样例验收。浏览器 XLSX/CSV 上传解析与导出仍未实际执行。本轮没有真实店铺新数据采集或导入，不以本机样例闭环代替生产业务数据操作。


## 后续导航位置调整

按用户后续要求，正式导航顺序调整为「图像创作 → 视频创作 → 三阶报告 → AI 工具 → 模型网关 → 管理」。只调整 AppShell 导航位置和原有 UI 测试中的顺序断言，二级页面保持。

本机 13 项导航测试通过；两文件发布工具的 35 项守卫测试通过；服务器候选的权限测试、报告 UI 测试、类型检查和正式构建通过，29 项 canary 与 29 项公网检查通过。以当时最新的 `/opt/sanjie-releases/20261002-studio-scene-v2` 为基准保留其他线上更新，于北京时间 2026-10-02 02:47:25 切换为 `/opt/sanjie-releases/20261002-sanjie-report-nav-v1`（进程 `sanjie-report-nav-20261002-v1`、端口 31937）；原基准进程仍 online。

正式浏览器已确认视频创作后紧接三阶报告，报告二级页面仍显示，当前选中状态正确。[导航位置证据](uat-sanjie-reports-evidence-20261002/nav-position.json)，[最新导航截图](uat-sanjie-reports-evidence-20261002/nav-position.png)。本次仅导航调整，未做生产数据写入。
