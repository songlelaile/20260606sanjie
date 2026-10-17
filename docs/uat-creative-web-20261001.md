# 创意网页迁移收口测试记录（2026-10-01）

本记录对应 `/Users/shaozhuang/20260606sanjie/public/creative` 网页候选。原插件 `/Users/shaozhuang/Desktop/关键词衍生插件` 未修改、未替换、未清空配置或成果。本记录不表示正式网站已切换，也不表示真实供应商出图/出视频已验收。

## 来源和功能范围

逐文件比对了原插件根目录当前真实源码与网页复制件。迁移保留原插件的主图、详情页（链接 JSON / 参考成详）、批量 SKU、爆款案例裂变、风格焕新以及视频工作台原有流程、约束、提示词和尺寸合同；补丁限于网页运行需要的兼容、隔离和资源。所列功能为代码与本地自动化验证，真实图片/视频生产另验。

- 主图：参考图/主体图上传、图像分析、链接 JSON 方向、表格导入、批量生成、图片档案、批量下载。
- 详情页：链接 JSON 方向、正式来源快照的参考成详、结构蓝图、屏幕顺序、编辑/确认、批量生成与来源隔离合同。
- SKU：原编辑/尺寸/替换主体规则，补齐 `TAOBAO_SKU_*` 导入上下文和草稿持久化消息接收模块。
- 爆款：原案例裂变及风格焕新入口和素材隔离规则。
- 视频：原直接生成、素材融合、参考重构、专家模式、脚本确认、供应商任务提交/查询/取消/重试、历史和结果预览；增加“下载视频到本机”按钮。

## 修复的实际缺陷

1. 原扩展 Worker 与页面脚本同页执行时同名函数互相覆盖（模型配置入口会递归发送消息）。给网页 Worker 增加闭包，网页模型配置打开当前页面原配置弹窗，网页路径按完整插件目录解析。
2. `authCheck` 永久缓存身份。现在每次敏感操作重新校验服务器身份，同时合并并发校验；页面锁定最初账号。切换账号或会话失效后阻止后续读写/转发并显示刷新提示。
3. 网页 `chrome.storage.local/session` 原先共享全局键。现在使用租户+用户名的账号命名空间。只复制有当前账号所有权证明的旧账号档案和 Key；旧原记录不删除。无所有权的旧 Key 不自动认领。
4. 视频 IndexedDB 的素材、草稿和记录原先没有完整账号隔离。新增素材/记录所有权、草稿账号键、列表/读取/删除检查。原旧记录仍留在同一数据库；只有具有当前账号历史引用的旧无主素材可读取。无法证明所有权的旧草稿保留但不自动显示，避免被下一位登录者认领。
5. 图片档案打开数据库前确认账号；网页后台自动清理只处理当前账号的既有回收站期限，不跨账号清理。
6. 视频 Key 配置弹窗展示当前账号已保存内容，并锁定打开时账号，保存前再次核对；未配置 Key 时仍返回当前账号身份，能力检查能区分身份与密钥状态。
7. 代理保留 `Request` 实际二进制内容和 `AbortSignal`，按 UTF-8/Blob 大小检查上传；保留内部字段 `__sz_*` 不允许被用户 multipart 字段覆盖。转发前检查 `creativeEntitlement.allowed`，未开通账号不会发起供应商请求。
8. 外部下载先通过已授权代理读取 Blob，再创建本机下载链接；错误通过 `chrome.runtime.lastError` 回传。单个下载 256 MiB 上限。网页上传保持 24 MiB 检查；服务端请求和响应限制见对应代理路由。
9. 补齐 CSV/Excel 导入依赖（原插件 `xlsx.full.min.js` 与 LICENSE）、SKU/参考成详消息模块和脚本加载顺序；全部 HTML 直接引用的静态资源均存在。
10. CDN 白名单允许淘宝参考图 `alicdn.com` / `tbcdn.cn` 的只读请求；供应商域名不允许非 443 端口。DNS 策略允许普通公网 IPv6，拒绝内网/映射/转换地址、无解析结果和无效 IP。
11. 浏览器阻止新窗口、窗口已关闭、网页无法跨站注入/采集时返回明确错误；不再用空 `executeScript` 结果假装成功。

## 2026-10-01 自动化验证

命令：

```sh
npx vitest run src/lib/creative-web.test.ts src/lib/creative-proxy.test.ts
```

结果：2 个测试文件、14 个测试全部通过。覆盖旧账号配置复制保留、拒绝无主旧密钥、切号阻断、Request 内容及取消信号、未开通拒绝、multipart 保留字段、Worker/页面同名隔离、视频素材/草稿/历史账号隔离、旧素材所有权证明、公网 IPv6与危险 DNS 地址、淘宝 CDN 只读及异常端口。

另外执行 `public/creative/**/*.js` 的 `node --check`：23 个 JavaScript 文件全部通过；HTML `src`/`href` 的本地资源检查：缺失 0 个。

测试通过的是兼容层、消息处理和隔离行为。IndexedDB 测试使用内存实现模拟真实 API，不代替目标浏览器存储验收。

补充：测试环境检测到 `window.__SANJIE_ENVIRONMENT` 时，chrome 存储及图片/视频物理 IndexedDB 另加环境命名空间，不从默认正式旧键迁移；默认正式环境仍使用原前缀。新增 VM 隔离检查已通过。本机真实 Chrome 的有限入口/导入/下载验收见 `docs/uat-creative-browser-20261001.md`，与下列用户原浏览器、真实供应商边界分别记录。

## 必须单独验收的边界

- 用户原浏览器 profile 中的真实 API Key、历史素材和同账号迁移结果仍未验收。独立临时 Chrome 已完成自主注册、已付款/受邀/管理员登录及有限入口流程，具体 56 项证据见浏览器记录；这些证据不替代原 profile 的迁移核对。
- 未使用真实付费供应商提交图像/视频任务；没有声称任何模型已真实生成、扣费、播完、下载或持久归档。
- 网页受浏览器跨域权限限制，不能直接注入并采集淘宝/天猫标签页。参考成详必须导入用户提供的正式来源快照，SKU/视频的跨页面采集需原插件输出或用户本地素材。原插件的商品页面拦截/自动采集不是网页原生已验能力。
- 原扩展和网页属于不同浏览器来源。插件原 IndexedDB/`chrome.storage` 历史不会因为网页代码复制而自动迁到网站；原插件资料仍在原处，未经用户提供导出不可伪称已迁移。
- 不具有账号归属证据的旧网页 Key、素材和草稿保留在原存储位置，当前补丁不自动认领。需用户在原浏览器确认归属后另做受控迁移。
- 视频结果 URL/编码有效期、1080P/4K 播放、大视频 256 MiB 下载、供应商创建/轮询/取消错误均需真实供应商验收。
- 本记录范围不含支付签名回调、邀请开通、账户注册、模型网关服务端和生产部署；这些由对应模块记录说明。

## 文件清单

修改：

- `public/creative/web-chrome.js`
- `public/creative/web-video-host.js`
- `public/creative/labs/image-prompt-lab/background.js`
- `public/creative/labs/image-prompt-lab/image-archive-store.js`
- `public/creative/labs/image-prompt-lab/promptlab.html`
- `public/creative/labs/ecommerce-video-studio/video-studio-store.js`
- `public/creative/labs/ecommerce-video-studio/video-studio.js`
- `src/lib/creative-proxy.ts`
- `src/lib/creative-proxy.test.ts`

新增原源码/依赖复制：

- `public/creative/src/taobao-sku-background.js`
- `public/creative/src/reference-detail-background.js`
- `public/creative/src/reference-detail-interceptor.js`
- `public/creative/src/vendor/xlsx.full.min.js`
- `public/creative/src/vendor/LICENSE`

新增验证记录：

- `src/lib/creative-web.test.ts`
- `docs/uat-creative-web-20261001.md`

## 最终证据复核

冻结候选以 `.codex-deploy/creative-uat-20261001/source/public/creative` 为准：23 个 JavaScript 文件，HTML 本地资源引用缺失 0 个。根工作区后续新增的 `creative-tools-contract.js`、`creative-tools-ui.js`、`creative-tools.css` 不在本轮冻结候选中，未计入上述验收。独立浏览器最终记录为 56/56，错误与失败请求均为 0；模型网关 hydration 和付款标题问题均已修复并复验。付款 UI 使用隔离库模拟流水，`realPayment=false`、`realProvider=false`；未把真实收款、供应商生成或原浏览器迁移标为通过。
