# 生图工作台优化与验收记录 · 2026-10-17

代码对比基线：`origin/feat/daily-data-v2`，`d161f31d4701f1980a509bbc4cb5e3df979f9905`。优化分支：`codex/image-studio-optimize`。原目录未提交的导入功能改动保留在原分支，本次使用独立工作区。实际生产另有历史、回执与封装更新，已按实际读取的源码做三方整合，没有把该分支视作完整生产现状。最终业务源码提交为 `00d029668dc4beba9037715fb401213383acd9c8`，已推送到优化分支，并于 2026-10-17T22:41:14.395556+08:00 切换正式流量。标准生产构建通过；现网登录、主图/详情切换、旧草稿和结果保留及匿名鉴权冒烟已通过。未执行数据库迁移、seed、清库或重置。

## 已完成的调整

- 收紧标题和工具区间距，统一输入、步骤、方案和结果卡片；桌面结果区随滚动保持可见，窄屏按单列排列，表单字号维持可读性。外层移动导航改为横向滚动，任务提醒支持换行。
- 删除 23 行已失效的装饰图标样式和一处被立即覆盖的网格声明，合并重复布局规则；保留全部生成入口、旧任务、历史、回执确认、配置和下载能力。
- 控制器的并发通知合并到下一帧绘制，每次回执的持久化仍独立等待完成。每次保存只制作一次控制器快照，移除回执刷新中重复的界面绘制。
- 结果勾选直接更新复选框和下载按钮，保留图片节点；关闭预览时释放大图节点；后台页面暂停用时刷新，恢复可见后同步状态。计时查找使用缓存映射，避免每秒重新遍历排序完整任务集合。
- 档案库每次事务核对当前登录账号，图片取回后再次校验；网页端的临时回执扫描限于当前账号，扩展端继续支持后台恢复。数据库打开和事务设置 15 秒超时，超时中止写入、关闭晚到连接，避免永久等待。
- 空批次清理改为同一事务内检查和删除，减少多标签页竞争；历史统计共用一次读取快照，减少重复 Blob 读取。历史弹窗拒绝页面重载、账号切换和晚到的响应。
- 身份和创作权限使用同一份最新鉴权响应，每次访问由两个串行身份请求减为一个；仍在每次操作重新检查权限，并保留账号变化后的阻断行为。
- 临时网络、429、5xx 或损坏的鉴权响应拒绝本次操作，允许后续重新校验，不再永久误锁账号；401/403 和已确认的账号变化仍阻断。身份数据库无法校验时返回无身份数据的 503，和真正失效的会话分开处理。
- 对原分支的 13 份 CSS、37 份正文脚本使用服务端显式清单合并，保留头部兼容桥和执行顺序；该粒度入口的 HTML/JS/CSS 请求由 52 个降到 4 个，约减少 92%。实际生产已有 15 份外部 JS、5 份 CSS 的封装，兼容候选对其做清单校验后原样透传，保留预加载、正文桥与 noscript 回退，不把 52→4 的结果宣称为现网收益。每个请求继续校验当前身份和权限，保留租户 ETag 与 `private, no-cache`，没有放宽限流或授权。两种入口形式均有回归覆盖。
- 共享账号存储键转换，区分“账号尚未就绪”和“账号已变化”；账号切换时先关闭原历史弹窗，保留新账号后来打开的弹窗。外层工作台隐藏时暂停轮询，重新显示时立即同步；主图与详情面包屑显示各自入口名。
- API 忙碌标志在排入界面绘制前立即同步；结果图支持键盘预览，关闭后恢复焦点。恢复旧草稿的提示保持在标题之前。
- 更新修改过的静态资源版本；修复本地演示服务未识别带版本号 `web-chrome.js`、导致演示桥缺少原生 fetch 的问题。
- 在外部资源之前安装工作台启动保护：合并脚本或样式缺失时显示错误及重新加载入口，避免空白页；保留原草稿恢复错误界面，超时后真实恢复成功仍可继续使用。对应资源失败、解析前失败与迟到恢复为 VM 故障注入验证。
- 启动保护只把当前创作资源目录内的脚本、样式加载失败和脚本 URL 可归属的运行错误视为资源故障；匿名、无 URL、浏览器扩展或无关脚本异常不会误锁工作台。增加 6 项回归，保留真实合并脚本解析错误、超时与原生恢复契约，未放宽 CSP。
- 修复 3 个基线测试文件中的显式 `any`：使用窗口、事件、动作记录、截图源和图片响应类型，并从 `unknown` 收窄错误对象。保留全部原有用例与断言，没有关闭 lint 规则、增加跳过或放宽阈值。
- 四份重叠 public 源码按基线、实际生产和本地候选逐块整合，保留生产额外的历史、账号隔离、回执校验、计费和请求排队处理。原始 UI 源码与实际加载的冻结 UI 已有不同版本，分别整合并保留各自合同；冻结包只精确替换已审阅的来源叶片，没有用旧分支整包重建生产资源。
- 实际生产冻结 CSS 另有 `.sg-shot textarea` 的 `12px !important` 覆盖。本轮复验发现后补上仅窄屏生效的 16px 规则，更新资源版本至 v3；390px 实际封装视口的 9 个可见表单控件均为 16px。

## 验证证据

| 验证 | 结果与边界 |
| --- | --- |
| `npm run typecheck` | 通过，见 [typecheck-final.txt](checks/typecheck-final.txt) |
| `npm test -- --maxWorkers=2` | 207 个测试文件通过、6 个跳过；3558 项通过、62 项跳过。比基线 3433 项通过增加 125 项回归测试，见 [test-final.txt](checks/test-final.txt) |
| `npm run lint` | 通过，无 lint 错误；仍有仓库已有 warning，见 [lint-final.txt](checks/lint-final.txt) |
| `npm run build` | 标准生产编译、lint、类型检查和路由生成全部通过，见 [build-final.txt](checks/build-final.txt) |
| 并发通知回归 | VM 测试中 100 次控制器通知只排入 1 次界面绘制，100 次持久化全部等待，控制器快照数为 100。此结果不是线上 100 张图压测 |
| 原分支合并入口的浏览器交互 | CUA 操作实际合并 public 工作台，通过可见且仅本地演示有效的“载入本地合成示例图”控件导入素材，完成分析 → 编辑方案 → 确认 → 生成 → 1/1 本机归档。确认前生成按钮禁用、确认后启用。系统文件选择器未完成验证，不能将这个合成素材入口描述为原生选择器通过。见 [bundled-ui-evidence.json](release-regression/bundled-ui-evidence.json) |
| 原分支合并入口与调用记录 | HTML、`web-chrome.js`、`studio-entry.css`、`studio-entry.js` 四类入口资源正常加载，启动与 bootstrap 均为 ready。本次预设分析 1 次、预设生成 1 次、本机归档 1 次、模型服务出站请求 0 次。实际合并 JS 另在运行时测试中验证共享桥、合同与 API 行为。见 [runtime-metrics.json](release-regression/runtime-metrics.json) |
| 实际生产封装兼容 | 原有 15 份外部 JS、5 份 CSS、预加载及 noscript 回退通过显式清单与路径校验后保持原样；合成 bundle 路径在该形式下仍经鉴权后返回 404。此项是本地兼容验证，不能作为部署完成或现网请求降至 4 个的证据 |
| 勾选与键盘预览 | 选中后下载按钮启用；Enter 打开预览、Escape 关闭，焦点返回“预览首页图”；关闭后预览图片节点数为 0 |
| 实际下载文件 | 点击下载后独立核验磁盘中的 PNG：1024 × 1024、460926 字节，文件哈希记录在交互证据中。浏览器下载事件观察器曾超时，完成判断以实际文件核验为依据 |
| 主图与详情草稿恢复 | 主图需求、结果和本机归档保留；切换后详情的独立草稿恢复，未互相覆盖 |
| 响应布局 | 主图、详情、广告、链接成图、复刻、DIY、旧 SKU、参考详情的既有 390px 检查均未出现页面横向溢出；主图/详情/广告另检查桌面和平板布局。合并版再次验证 390px 视口的 scrollWidth 为 390、表单字号均为 16px，预览宽度 366px、左边距 12px |

标准构建早先被 `src/lib/link-image-result-actions.test.ts`、`src/lib/reference-detail-screenshot-source.test.ts`、`src/lib/reference-detail-screenshot-ui.test.ts` 中的基线 lint 错误阻断。上述类型问题现已修复，标准 lint、类型检查和构建均已通过。早先 [build-no-lint.txt](checks/build-no-lint.txt) 保留为排障历史，不再作为最终构建依据。

默认并发的末轮测试在未修改的 `link-image-ui.test.ts` 大图用例上出现一次 5 秒超时；限制为 2 个 worker 后，全量复验全部通过。没有加大超时阈值或增加跳过范围。最终测试输出见 [test-final.txt](checks/test-final.txt)。

最终 JS/helper 兼容性全量测试在最后一轮 helper 修改后，于 22:01:57（上海时间）开始；末轮仅补齐窄屏公共 CSS 和版本号，标准生产构建再次通过，并重新检查实际生产封装的窄屏表单与预览。四份 public 源码的整合补丁保存在 [reviewed-public-source.patch](deployment/reviewed-public-source.patch)，文件范围、补丁哈希及候选覆盖包哈希见 [reviewed-source-metadata.json](deployment/reviewed-source-metadata.json)。覆盖包 `sanjie-prod-overlay-payload-20261017.json.gz` 的 SHA-256 为 `bce68d4b61c1b2b82333cefbd2fc262c8dca1098a42a96f52b9a707b559ab4c7`；记录未写入凭据或环境配置。该覆盖包是首次整合输入，最终另恢复了独立整合的原始 UI 源码，并补齐窄屏字号和资源版本。最终补丁、原始/冻结 UI 的不同哈希及 [发布回执](deployment/deployment-receipt.json) 一并记录；生产发布与只读冒烟已经完成。

保留的[启动故障截图](release-regression/bundled-startup-error.jpg)和[网络及异常记录](release-regression/bundled-startup-network.json)是已定位、已修复的历史误判：应用资源全部为 200，未记录网络加载失败；无来源 URL 的匿名 CSP `unsafe-eval` 拒绝却被旧监听器当作应用资源失败。现在监听器仅归因于所属创作脚本与样式，新增回归覆盖匿名异常忽略和真实资源错误保留；CSP 限制保持不变。该修复已包含在本轮全量测试中，后续合并版本地合成素材链路已完成上述浏览器复验。

浏览器演示服务限定本机，CSP 禁止外部请求，模型代理固定拒绝调用。使用独立本地演示标签页、演示环境存储前缀和合成账号，没有读取生产租户数据、使用真实密钥或调用付费模型，也未更改扩展权限或 CSP。素材通过明确标注的可见演示控件导入；原生系统文件选择器、真实服务商生成与计费、线上多租户并发及数据库负载尚未验收。外层 React 工作台另已在现网登录态下检查：主图/详情面包屑和入口正确，切回主图后原素材、草稿和两项既有结果保留；未点击付费分析、生图或历史清理。现网截图仅保存在本机，未上传到仓库。

## 实际生产封装与发布验证

生产目录与开发分支有额外发布内容，因此在现有生产源码的独立副本中整合，没有直接用开发分支替换整站。全部 `src` 和已有 JS/CSS/HTML 的对照只有审阅过的 19 份业务文件（含 4 个已加载封装）及 8 份测试夹具变化，其他模块无额外源码差异；见 [source-parity-review.json](deployment/source-parity-review.json)。

- 最终生产候选的 [完整构建](deployment/production-build-final.txt)、[lint](deployment/production-lint-final.txt)、[类型检查](deployment/production-typecheck-final.txt) 均通过。构建先前因 `.bin` 指向旧发布目录而混用了两份 Next，已仅在候选中复制为独立目录并保留相对命令链接，未安装依赖或修改旧发布目录。
- **实际生产完整测试仍有 135 项既有失败。** 未修改的原生产副本为 3464 通过、135 失败、278 跳过；最终候选为 3485 通过、135 失败、277 跳过。按文件、用例身份逐一对照无新增失败；一项改名用例只有在两边都命中同一冻结叶片前置失败时才映射，明确保留在报告中。见 [逐项对照](deployment/production-test-comparison.json) 和 [夹具修正补丁](deployment/production-fixture-adjustments.patch)。这不是生产测试全绿的声明，也没有把 135 项失败改为跳过或通过。
- 实际生产的 15 JS / 5 CSS 加 HTML，共 21 个资源逐文件 SHA-256 与最终候选一致。隔离演示对其完成合成素材导入、预设分析、编辑方案、确认门槛、1/1 生成及本机归档、勾选、键盘预览、下载和第二个视口恢复。PNG 为 1024×1024、460926 字节；模型出站请求为 0。390px 视口无横向溢出，9 项表单均为 16px，预览宽 366px、左边距 12px。见 [交互证据](production-packed-regression/ui-evidence.json)、[调用记录](production-packed-regression/runtime-metrics.json)、[资源哈希](production-packed-regression/actual-asset-hashes.json)。这是明确预设的本地样例验证，未验证真实服务商质量、计费或原生文件选择器。
- 候选启动环境只继承旧服务实际启动变量，排除 PM2/Node 的内部通信变量；在内存中比较 27 项会话、数据库、Cookie、服务商及存储配置的哈希，启动前后相同，没有写出凭据值或这些配置的哈希。数据库 schema、环境链接和受保护生成代理等保持一致。
- Nginx 在部署锁和原配置哈希校验下切换，语法检查通过后平滑 reload。常规站点指向候选 53450；精确生成代理继续经原 Gate 53449 到原后端 53448，UAT 44119 保持独立。其他常规 API 随候选运行，其源码和数据配置保持原生产版本。旧服务继续在线，183 份旧静态资源在候选中保留，支持已打开页面继续加载。
- [发布后只读回归](deployment/postdeploy-smoke.json) 验证正式动态登录页为新 build、UAT 动态登录页仍为旧 UAT build，代理双路径维持 405，匿名鉴权和带条件 ETag 的资源请求均为 401，原 Gate 进程与配置未变。现有 access log 关闭，没有宣称从访问日志完成上游追踪。

切流、回执及 PM2 持久化见 [traffic-switch.txt](deployment/traffic-switch.txt)、[deployment-receipt.json](deployment/deployment-receipt.json)、[pm2-save.txt](deployment/pm2-save.txt)。切流后首个新 manifest 探针曾由 reload 期间的旧 worker 返回一次 404，重试后读取到新 build；正式健康核验通过。回滚脚本保留哈希和部署锁保护：[rollback-traffic.py](deployment/rollback-traffic.py)。旧发布目录仍被生成代理使用，不能作为闲置副本删除。

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
- [实际生产封装桌面结果](production-packed-regression/results-desktop.jpg)
- [实际生产封装 390px 预览](production-packed-regression/preview-mobile-390.jpg)

## 后续结构调整的边界

当前旧版 `promptlab.js` 同时提供共享账号、素材、方案、生成、历史与回执桥。此轮为原分支的粒度资源提供合并入口，并兼容实际生产的既有冻结封装，仍保留全部脚本内容。继续按路由减少执行代码时，不能只按文件名删除：主脚本在载入时依赖部分旧模式合同，场景模块依赖解析期间的 DOMContentLoaded 时序。大规模拆包需配套覆盖所有旧入口别名、资源失败和启动时序的回归测试。

Claude 的建议中，动态页高容器、空闲 iframe 回收及跨事务鉴权复用保留为后续工作：现有外层祖先没有确定高度，且任务和回执依赖原页面存活；本轮不在缺少完整生命周期验证时卸载页面或复用旧身份。实际完成的改动与这些建议分别列示，防止把建议误报为交付。

复现合并资源的本地样例：`node --import tsx scripts/studio-main-demo.cjs --port 18803 --bundle`。该服务只监听本机，生成响应明确为预设样例。

Claude 客户端已绑定同一优化工作区，独立源码审查结果存于 `../image-studio-optimization-claude-review-20261017.md`。该审查与本记录中的运行验证分别标注，审查建议不自动等同于已实施。
