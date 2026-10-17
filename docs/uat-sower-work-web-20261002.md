# Sower Work 网页版验收记录（2026-10-02）

已部署到 **https://shaozhuangai.com/sower-work**。管理员导航第一项为 Sower Work，位于图像创作之前；真实 Chrome 已加载完整工作台。生产候选构建、30 项站点检查、12 项账号权限检查和 11 项真实云接口检查均通过。

## 已实现的范围

- 管理账号主导航第一项为 **Sower Work**，位于图像创作之前；普通账号不显示该入口。
- `/sower-work` 页面和 `/api/sower-work/access` 独立验证签名 Cookie，再实时查数据库核对 `status=active`、`authRole` 与会话角色一致、`tenantId` 与会话一致。失效会话返回 401，合法普通账号返回 403，数据库故障返回 503；响应禁止缓存。权限不依赖部署基线的 `getCurrentUser` 实现。
- `/sower-work/app/` 使用独立云端运行目录、账号、工作区及模型配置。bridge 在 HTML、静态资源、HTTP、上传、文件流和 WebSocket 握手前重验网站管理权限；写请求验证同源 Origin，WebSocket 每 30 秒重验。内部会话不进入浏览器。
- prefix 脚本覆盖内部 fetch、XHR、WebSocket、EventSource 和图片 URL。当前 renderer 使用 HashRouter，图片入口为 `/sower-work/app/#/image-studio`，长详情为 `#/image-studio/details`。Service Worker 注册被禁止，其失败由 renderer 捕获；真实 Chrome 首次渲染、首页、模型设置和生图页均正常打开。

## 本地验证

| 验证层级 | 命令 / 证据 | 结果 |
| --- | --- | --- |
| 独立权限与 API | `npx vitest run src/lib/sower-work-access.test.ts src/app/api/sower-work/access/route.test.ts` | 19 项通过，含角色降级、租户迁移、停用、删除、数据库故障 |
| 页面与主导航 SSR | `npx vitest run --config src/components/sower-work/vitest-ui.config.ts` | 12 项通过，含入口顺序、普通账号不可见、页面门禁 |
| 类型检查 | `npx tsc --noEmit` | 独立权限修复后通过 |
| bridge | `node --test scripts/sower-work-web/bridge.test.mjs` | 8 项通过，无 skip |
| 真实 ControlStore | [封包测试记录](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/cloud-release-final-receipt.json) | 1 项通过，无 skip |
| 最新 renderer 构建与静态资源 | [构建证据](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/sower-stage/build-evidence/result.json) | 40.86 秒，8829 模块；242 文件、16,771,775 字节，HTML 引用资源完整 |

前一次完整质量门的 [日志](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/predeploy-full-final.log) 记录 typecheck、lint、test、build 通过，1173 项测试通过、17 项明确 skip。该日志早于最后一次独立权限修复，不能代替最终生产候选验收；最终候选的 62 项权限 / middleware 测试、12 项 UI 测试、类型检查与 Next 生产构建已通过。

关键身份：当前权限 helper SHA-256 为 `b7822a9845ce276ff586f9492c97a537e4b3d84d51e91506d4e4eb0e90b2e194`；renderer `index.html` SHA-256 为 `26661e26e982b0c654c3d88708a5ed99b0cee6960d8c3bc5734fadece18d5b98`。

## 真实独立引擎证据

[actual-engine.json](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/actual-engine-test/actual-engine.json) 记录 `passed=true`，使用独立临时 runtime、fixture 网站授权和真实引擎，通过真实 HTTP / WebSocket 接口验证：

- 引擎健康、内部账号会话、27 个内置助手；初始 provider 列表为空。
- provider 设置创建、修改及跨账号拒绝；创建并列出测试会话，未发送消息。
- WebSocket 101、账号间消息隔离；真实 multipart 上传与图片流字节一致。
- 自己的项目文件流可读，其他账号项目 / 会话文件流被拒绝；内容预览、临时生成物文件 fixture 归属、上传会话归属、symlink、目录穿越和 URI 检查通过。

`providerCalls=0`、`modelMessageCalls=0`。这证明独立运行服务与文件链路，不证明真实模型生成或业务页面采集。测试临时进程、目录及端口已按测试清理流程退出。

## 桌面保留证据

最新 renderer 在隔离 `sower-stage` 源码快照中构建，未覆盖 `/Users/shaozhuang/Desktop/SowerWork/out/`，未启动或重启原桌面客户端。1772 个快照文件在构建后仍逐文件匹配原工作区；原 `out/` 的 600 个文件前后清单完全一致，SHA-256 为 `c18779a8ff01d0905680d02a550707646e4c1fcf17775fb82fb62225054096d0`。

构建与封包记录均声明未复制桌面 runtime、用户历史、登录或模型配置。Sentry 上传及供应商调用未执行。最终读回确认原 Electron PID 7753、gateway PID 29665 和原引擎 PID 29667 仍在运行，没有重启。

## 生产部署和实际验收

以现场最新 `/opt/sanjie-releases/20261002-studio-history-v2` 为基线，仅合入 10 个新文件与 3 个共享文件的固定插入。保留原站点进程、网站环境、数据库、媒体、下载及更新资源；无数据库迁移。遵守共享发布锁，Nginx 校验后平滑重载，保留可回滚配置。

| 项目 | 最终证据 |
| --- | --- |
| 网站发布 | `/opt/sanjie-releases/20261002-sower-web-v2`，PM2 `sanjie-sower-web-20261002-v1`，loopback 32151 |
| Build ID | `UQd4A1CNtkleiysKWjF0U` |
| 最终 Nginx SHA-256 | `7e692ebce4857ec9cf78a2b2e2baeeb8ec59b692c4f745587d164b72720ac873` |
| 云端运行 | PM2 `sower-work-web-20261002-v1`，loopback 32150；实际 Node 24.11.0 以非 root UID 993 运行 |
| 云端引擎 | 官方 Linux x64 AionCore v0.2.2，独立 `/var/lib/sower-work-web`；不导入桌面历史、登录或模型密钥 |
| 最新站点检查 | 30 项候选及 30 项公开站点检查通过，旧站点与下载资源保留 |
| 账号检查 | 12/12，通过只读数据库选择已有账号并签发内存短期会话；管理员页面 / API / app / health 200，普通账号页面跳回首页且 API / app / health 403，匿名页面去登录且接口 401；均禁止缓存 |
| 实际云接口 | 11/11：24 个 Linux 内置助手、空 provider 列表、WebSocket 101、独立空测试会话创建与列出、68 字节 PNG 上传及哈希精确读取 |
| 真实浏览器 | 管理员已有登录进入，导航顺序正确；首页、模型设置和生图页均加载，模型状态明确为尚未配置；测试空会话已可恢复归档，首页暂无对话历史 |

第一次自动账号验收因测试脚本缺少 Cookie 整值传输编码而失败；修复脚本并通过真实 HTTP + 官方 Next Cookie 传输测试后，线上 12/12 重新通过。没有修改生产权限代码或绕过认证。图片文件、会话及 WebSocket 验收未发送模型消息：`modelMessagesSubmitted=0`、`externalProviderRequestsSubmitted=0`、`providerConfigurationWrites=0`。

完整生产回执已下载并校验 SHA-256 `fc3be1dd6941983cec728764ec04c3ace4d14fad1e2059bf946e5560fa2a2a62`：

- [发布回执](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/evidence/production/publication-receipt.json)
- [12 项权限验收](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/evidence/production/permissions-acceptance.json)
- [11 项真实云接口验收](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/evidence/production/cloud-http-smoke.json)
- [生产构建与测试摘要](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/evidence/production/sower-production-summary-v1.json)
- [真实浏览器记录](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/evidence/browser-acceptance.json)
- [实际工作台截图](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/evidence/admin-web-workspace.jpg)
- [生图页截图](/Users/shaozhuang/20260606sanjie/.codex-deploy/sower-work-web-20261002/evidence/admin-web-image-studio.jpg)

## 使用范围

网页版需在网页设置中单独配置模型 API，当前尚未配置；真实模型生成、付费供应商调用与业务采集没有验收。网页任务运行在服务器，桌面本机文件及本机 Chrome CDP 能力仍属于桌面端。当前仅面向网站管理账号开放，云端文件接口按账号工作区校验，未建立每账号独立的操作系统沙箱。
