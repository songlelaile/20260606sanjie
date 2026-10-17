# 生图工作台优化与验收记录 · 2026-10-17

基线：`origin/feat/daily-data-v2`，`d161f31d4701f1980a509bbc4cb5e3df979f9905`。优化分支：`codex/image-studio-optimize`。原目录未提交的导入功能改动保留在原分支，本次使用独立工作区。

## 已完成的调整

- 收紧标题和工具区间距，统一输入、步骤、方案和结果卡片；桌面结果区随滚动保持可见，窄屏按单列排列，表单字号维持可读性。外层移动导航改为横向滚动，任务提醒支持换行。
- 删除 23 行已失效的装饰图标样式和一处被立即覆盖的网格声明，合并重复布局规则；保留全部生成入口、旧任务、历史、回执确认、配置和下载能力。
- 控制器的并发通知合并到下一帧绘制，每次回执的持久化仍独立等待完成。每次保存只制作一次控制器快照，移除回执刷新中重复的界面绘制。
- 结果勾选直接更新复选框和下载按钮，保留图片节点；关闭预览时释放大图节点；后台页面暂停用时刷新，恢复可见后同步状态。计时查找使用缓存映射，避免每秒重新遍历排序完整任务集合。
- 档案库每次事务核对当前登录账号，图片取回后再次校验；网页端的临时回执扫描限于当前账号，扩展端继续支持后台恢复。数据库打开和事务设置 15 秒超时，超时中止写入、关闭晚到连接，避免永久等待。
- 空批次清理改为同一事务内检查和删除，减少多标签页竞争；历史统计共用一次读取快照，减少重复 Blob 读取。历史弹窗拒绝页面重载、账号切换和晚到的响应。
- 身份和创作权限使用同一份最新鉴权响应，每次访问由两个串行身份请求减为一个；仍在每次操作重新检查权限，并保留账号变化后的阻断行为。
- 临时网络、429、5xx 或损坏的鉴权响应拒绝本次操作，允许后续重新校验，不再永久误锁账号；401/403 和已确认的账号变化仍阻断。身份数据库无法校验时返回无身份数据的 503，和真正失效的会话分开处理。
- 服务端用显式清单合并 13 份 CSS 和 37 份正文脚本，保留头部兼容桥和原执行顺序。受保护入口的 HTML/JS/CSS 请求由 52 个降到 4 个，约减少 92%。每个请求继续校验当前身份和权限，保留租户 ETag 与 `private, no-cache`，没有放宽限流或授权。资源路径、内容哈希、语法和文件系统边界均有回归覆盖。
- 共享账号存储键转换，区分“账号尚未就绪”和“账号已变化”；账号切换时先关闭原历史弹窗，保留新账号后来打开的弹窗。外层工作台隐藏时暂停轮询，重新显示时立即同步；主图与详情面包屑显示各自入口名。
- API 忙碌标志在排入界面绘制前立即同步；结果图支持键盘预览，关闭后恢复焦点。恢复旧草稿的提示保持在标题之前。
- 更新修改过的静态资源版本；修复本地演示服务未识别带版本号 `web-chrome.js`、导致演示桥缺少原生 fetch 的问题。
- 在外部资源之前安装工作台启动保护：合并脚本或样式缺失时显示错误及重新加载入口，避免空白页；保留原草稿恢复错误界面，超时后真实恢复成功仍可继续使用。对应资源失败、解析前失败与迟到恢复为 VM 故障注入验证。
- 启动保护只把当前创作资源目录内的脚本、样式加载失败和脚本 URL 可归属的运行错误视为资源故障；匿名、无 URL、浏览器扩展或无关脚本异常不会误锁工作台。增加 6 项回归，保留真实合并脚本解析错误、超时与原生恢复契约，未放宽 CSP。
- 修复 3 个基线测试文件中的显式 `any`：使用窗口、事件、动作记录、截图源和图片响应类型，并从 `unknown` 收窄错误对象。保留全部原有用例与断言，没有关闭 lint 规则、增加跳过或放宽阈值。

## 验证证据

| 验证 | 结果与边界 |
| --- | --- |
| `npm run typecheck` | 通过，见 [typecheck-final.txt](checks/typecheck-final.txt) |
| `npm test -- --maxWorkers=2` | 207 个测试文件通过、6 个跳过；3532 项通过、62 项跳过。比基线 3433 项通过增加 99 项回归测试，见 [test-final.txt](checks/test-final.txt) |
| `npm run lint` | 通过，无 lint 错误；仍有仓库已有 warning，见 [lint-final.txt](checks/lint-final.txt) |
| `npm run build` | 标准生产编译、lint、类型检查和路由生成全部通过，见 [build-final.txt](checks/build-final.txt) |
| 并发通知回归 | VM 测试中 100 次控制器通知只排入 1 次界面绘制，100 次持久化全部等待，控制器快照数为 100。此结果不是线上 100 张图压测 |
| 合并版浏览器交互 | CUA 操作实际合并 public 工作台，通过可见且仅本地演示有效的“载入本地合成示例图”控件导入素材，完成分析 → 编辑方案 → 确认 → 生成 → 1/1 本机归档。确认前生成按钮禁用、确认后启用。系统文件选择器未完成验证，不能将这个合成素材入口描述为原生选择器通过。见 [bundled-ui-evidence.json](release-regression/bundled-ui-evidence.json) |
| 合并后的入口与调用记录 | HTML、`web-chrome.js`、`studio-entry.css`、`studio-entry.js` 四类入口资源正常加载，启动与 bootstrap 均为 ready。本次预设分析 1 次、预设生成 1 次、本机归档 1 次、付费模型出站请求 0 次。实际合并 JS 另在运行时测试中验证共享桥、合同与 API 行为。见 [runtime-metrics.json](release-regression/runtime-metrics.json) |
| 勾选与键盘预览 | 选中后下载按钮启用；Enter 打开预览、Escape 关闭，焦点返回“预览首页图”；关闭后预览图片节点数为 0 |
| 实际下载文件 | 点击下载后独立核验磁盘中的 PNG：1024 × 1024、460926 字节，文件哈希记录在交互证据中。浏览器下载事件观察器曾超时，完成判断以实际文件核验为依据 |
| 主图与详情草稿恢复 | 主图需求、结果和本机归档保留；切换后详情的独立草稿恢复，未互相覆盖 |
| 响应布局 | 主图、详情、广告、链接成图、复刻、DIY、旧 SKU、参考详情的既有 390px 检查均未出现页面横向溢出；主图/详情/广告另检查桌面和平板布局。合并版再次验证 390px 视口的 scrollWidth 为 390、表单字号均为 16px，预览宽度 366px、左边距 12px |

标准构建早先被 `src/lib/link-image-result-actions.test.ts`、`src/lib/reference-detail-screenshot-source.test.ts`、`src/lib/reference-detail-screenshot-ui.test.ts` 中的基线 lint 错误阻断。上述类型问题现已修复，标准 lint、类型检查和构建均已通过。早先 [build-no-lint.txt](checks/build-no-lint.txt) 保留为排障历史，不再作为最终构建依据。

默认并发的末轮测试在未修改的 `link-image-ui.test.ts` 大图用例上出现一次 5 秒超时；限制为 2 个 worker 后，全量复验全部通过。没有加大超时阈值或增加跳过范围。最终测试输出见 [test-final.txt](checks/test-final.txt)。

保留的[启动故障截图](release-regression/bundled-startup-error.jpg)和[网络及异常记录](release-regression/bundled-startup-network.json)是已定位、已修复的历史误判：应用资源全部为 200，未记录网络加载失败；无来源 URL 的匿名 CSP `unsafe-eval` 拒绝却被旧监听器当作应用资源失败。现在监听器仅归因于所属创作脚本与样式，新增回归覆盖匿名异常忽略和真实资源错误保留；CSP 限制保持不变。该修复已包含在本轮全量测试中，后续合并版本地合成素材链路已完成上述浏览器复验。

浏览器演示服务限定本机，CSP 禁止外部请求，模型代理固定拒绝调用。使用独立本地演示标签页、演示环境存储前缀和合成账号，没有读取生产租户数据、使用真实密钥或调用付费模型，也未更改扩展权限或 CSP。素材通过明确标注的可见演示控件导入；原生系统文件选择器、真实服务商生成与计费、线上多租户并发、数据库负载及上线后表现尚未验收。外层 React 工作台由组件测试和生产编译覆盖，本地 public 演示页没有渲染该 React 外壳，因此其原生运行布局仍需要部署环境复核。

## 浏览器截图

- [主图桌面输入](browser/layout-main-desktop.jpg)
- [主图手机输入](browser/layout-main-mobile.jpg)
- [桌面方案](browser/layout-main-plan-desktop.jpg)
- [桌面结果](browser/layout-main-results-desktop.jpg)
- [手机结果与已选状态](browser/layout-main-results-mobile.jpg)
- [手机图片预览](browser/layout-preview-mobile.jpg)
- [旧 SKU 手机布局](browser/layout-sku-mobile.jpg)
- [本地演示请求与调用记录](browser/runtime-evidence.json)
- [合并版桌面结果](release-regression/bundled-results-desktop.jpg)
- [合并版桌面预览](release-regression/bundled-preview-desktop.jpg)
- [合并版手机结果](release-regression/bundled-results-mobile.jpg)
- [合并版手机预览](release-regression/bundled-preview-mobile.jpg)

## 后续结构调整的边界

当前旧版 `promptlab.js` 同时提供共享账号、素材、方案、生成、历史与回执桥。此轮服务端已合并网络资源，但仍保留全部脚本内容。继续按路由减少执行代码时，不能只按文件名删除：主脚本在载入时依赖部分旧模式合同，场景模块依赖解析期间的 DOMContentLoaded 时序。大规模拆包需配套覆盖所有旧入口别名、资源失败和启动时序的回归测试。

Claude 的建议中，动态页高容器、空闲 iframe 回收及跨事务鉴权复用保留为后续工作：现有外层祖先没有确定高度，且任务和回执依赖原页面存活；本轮不在缺少完整生命周期验证时卸载页面或复用旧身份。实际完成的改动与这些建议分别列示，防止把建议误报为交付。

复现合并资源的本地样例：`node --import tsx scripts/studio-main-demo.cjs --port 18803 --bundle`。该服务只监听本机，生成响应明确为预设样例。

Claude 客户端已绑定同一优化工作区，独立源码审查结果存于 `../image-studio-optimization-claude-review-20261017.md`。该审查与本记录中的运行验证分别标注，审查建议不自动等同于已实施。
