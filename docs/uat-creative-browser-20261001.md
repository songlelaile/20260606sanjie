# 创意与开通候选：本机真实浏览器验收（2026-10-01）

验收目标为 `http://localhost:32101` 的独立 UAT 服务，使用 Playwright 启动独立临时 Chrome profile，不连接用户现有 Chrome、扩展、正式网站会话或原模型配置。全部非 localhost 网络请求被浏览器测试路由阻止；没有供应商 API Key，没有真实充值、支付或图像/视频生成。

测试使用 `source/acceptance/local-test-accounts.json` 中本机测试账号；口令未输出、未出现在截图中。自主注册只在 UAT 数据库创建测试用户。已付款用户、受邀用户和管理员均通过真实登录表单登录。

## 结果

最终 `browser-acceptance.json` 为 **56 / 56 个检查通过**；最终 `pageerror`、console error 和 failed request 列表均为空。验收脚本与详细结果保存于：

- `.codex-deploy/creative-uat-20261001/browser/browser-uat.cjs`
- `.codex-deploy/creative-uat-20261001/browser/final-focused.cjs`
- `.codex-deploy/creative-uat-20261001/browser/payment-ui-final.cjs`
- `.codex-deploy/creative-uat-20261001/browser/browser-acceptance.json`

完成的真实点击或读取：

| 范围 | 实际操作和结果 |
| --- | --- |
| 自主注册 | 点击“自主注册”、填写本机测试姓名/手机号/口令、提交“注册独立工作区”，进入工作台；未充值用户看到充值门禁，DOM 没有创意 iframe |
| 已付款用户 | 通过登录表单登录 self 用户，进入作图工作台 |
| 作图五模式 | 逐一点击主图、详情、参考成详、批量 SKU、爆款裂变，等待正确 iframe URL、页面模式和加载完成；每个页面标题正确，模型配置弹窗均实际打开、关闭 |
| 本地上传 | 在主图参考图文件输入中选择本机 PNG fixture，页面出现“已载入通用参考图 1 / 6”和预览；没有提交图像分析或生成 |
| CSV 导入 | 实际通过文件输入导入本机 CSV，浏览器加载本地 Excel/CSV parser；得到 1 条 JSON。样例缺少部分正式规划字段，页面如实提示主图/详情完整字段均 0/1，未发起 AI 调用 |
| 下载导入模板 | 点击“下载导入模板”，真实浏览器触发下载并保存 `link-import-template.csv` |
| 空结果下载 | 点击“下载全部”，页面显示“没有可下载图片”，没有伪造成果或下载成功 |
| 本地下载桥 | 在真实 iframe 调用网页下载桥，下载本机 data URL PNG fixture；浏览器产生真实 download 事件并保存 `uat-local-only.png`。该 fixture 不代表供应商生成结果 |
| 视频页面 | 点击“生成视频”，真实视频 iframe 加载；打开“配置视频 API”对话框后取消，没有保存密钥；逐一点击脚本直出/direct、脚本帮写/assist、爆款复刻/remix 三模式 |
| 受邀用户 | 通过登录表单登录 invited 用户，作图 iframe 成功加载 |
| 管理付款 | 管理员通过登录表单登录，进入 `/management/payments`；查询后显示原 UAT 已到账订单。追加付款 UI 验收：self 通过本机 API 创建第二笔 starter ¥99.00 待确认订单；管理员实际点击“核对付款”，填写唯一 `UAT-UI-...` 模拟凭证、99.00 和“本机隔离库模拟，非真实收款”，点击“已核实到账，确认开通”；收到 HTTP 200，列表显示两笔已到账。self 重新登录后服务器 `allowed=true`，创意 iframe 正常加载。这是隔离库模拟，没有真实收款 |
| 模型中转管理 | 管理员进入 `/models`，等待真实中转配置加载；Base URL 输入、密码类型 API Key 输入、保存配置、测试已保存连接和同步上游模型按钮存在。滚动到管理表单截图；没有保存 Key，没有点击连接测试/同步 |
| 环境隔离 | 真实页面与 iframe 的 `window.__SANJIE_ENVIRONMENT` 为 `creative-20261001`；本机创意配置键均使用环境+账号命名空间，图片和视频物理 IndexedDB 分别为 `sz_image_archive_v1:environment:creative-20261001` 与 `sz_ecommerce_video_studio:environment:creative-20261001` |

## 发现与处理

- 第一轮驱动切换 iframe 后过早点击未绑定事件的配置按钮。最终驱动等待 iframe URL、正确模式 class 和 load，再点击；五模式均通过。这是测试等待修正，未据此更改业务代码。
- 最初模型网关出现 SSR/client origin 导致的 hydration mismatch。根任务已修复，后续真实页面验收未再出现该错误；最终错误列表为空。
- 最初视频对话框取消后的断言与 IndexedDB 名称读取过早。最终分别等待 dialog detach、数据库 open 完成后检查，结果通过。
- 付款页面早期截图白色 panel 的标题继承浅色。根任务已修复；最终重拍付款页面，标题颜色 `rgb(15, 23, 42)`、背景 `rgb(255, 255, 255)`，计算对比度 17.85，标题清晰可读。创意范围没有擅自修改支付/管理组件。

## 截图与文件

截图位于 `.codex-deploy/creative-uat-20261001/browser/`：

- `01-self-register-unpaid.png`：自主注册后未充值门禁。
- `02-image-main-config.png`、`02-image-detail-config.png`、`02-image-reference-config.png`、`02-image-sku-config.png`、`02-image-viral-config.png`：五种作图入口真实配置弹窗。
- `03-main-local-upload.png`、`03-main-csv-import.png`：本机图片选择及 CSV 导入反馈。
- `04-video-key-dialog.png`、`05-video-workbench.png`：视频配置弹窗及工作台。
- `06-invited-studio.png`：受邀用户工作台。
- `07-admin-payment-review.png`：查询完成后的管理员付款订单表。
- `08-model-relay-settings.png`：滚动至真实中转站管理表单。
- `09-admin-payment-form-simulated.png`、`10-admin-payment-confirmed-simulated.png`、`11-self-after-simulated-payment.png`：本机模拟付款表单、模拟确认成功和用户访问复核。
- `uat-local-only.png`、`link-import-template.csv`：真实浏览器本机下载产物。

追加模拟付款记录：订单 `cmupnzpmd00014vol9auznwf8`，9900 分，凭证 `UAT-UI-579e8484-a538-4f42-8ef7-bc98ec2854f5`，状态 paid；所有操作均有 `creative-20261001` 环境标记。第一次测试驱动误将正常下单的 HTTP 201 当成失败，修正为接受成功状态后复用已创建待确认订单，未重复下单；没有修改业务代码。

## 未验收的业务

没有把以下范围标成通过：真实收款/支付回调、针对真实收款的管理员到账核验、真实中转站 Key 保存/连通/同步、供应商图像生成、完整参考成详来源导入和批量生成、SKU 图像生成、风格焕新生产、视频提交/查询/取消/重试、真实视频结果播放和下载、大视频 256 MiB 下载、用户原浏览器已有素材/账号配置迁移、正式网站部署。

本轮证明独立本机候选的注册/登录门禁、网页入口、配置弹窗、本机导入与下载桥和环境隔离能在真实 Chrome 浏览器中运行。供应商与支付闭环由单独证据验收。

最终文档复核：56 项均为本机浏览器检查；另行静态检查的冻结候选含 23 个 JavaScript 文件，HTML 本地资源缺失 0 个。根工作区后续新增 `creative-tools-*` 文件未包含在本轮冻结候选或上述浏览器证据中。浏览器结果中的 `realPayment` 与 `realProvider` 均为 false。
