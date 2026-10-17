# 官网登录跳转修复记录（2026-09-06）

## 线上结果

2026-09-06 17:47（Asia/Shanghai）已完成 Nginx 代理配置修复。首页和受保护页面的匿名访问现在返回 `307 Location: https://shaozhuangai.com/login`，跟随跳转最终为 200。此次上线只变更 Nginx 配置；应用继续运行今日的自更新版本。

## 原因与生效修复

修复前，线上 `/`、`/tools` 和 www 首页将匿名请求跳转到 `https://localhost:3040/login`。生产源码的 middleware 第 94、106 行沿用 `request.nextUrl.clone()`，把 Next.js 内部 origin 带入响应。Nginx 原有效配置中没有显式 `proxy_redirect` 规则。

在 `/etc/nginx/conf.d/sanjie.conf` 三处 `proxy_pass http://127.0.0.1:3040;` 后增加：

```nginx
proxy_redirect ~^https?://(?:localhost|127[.]0[.]0[.]1):[0-9]+(/.*)$ https://shaozhuangai.com$1;
```

规则仅替换本机地址及端口，保留路径、参数，固定官网域名；不使用请求 Host 决定目标。该规则也覆盖后续应用端口变化。作用范围为上游 Location/Refresh 响应头。语法依据：[Nginx proxy_redirect 文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_redirect)。

配置变更使用现状断言、三处匹配计数、备份、替换前内容比对、原子替换。`nginx -t` 成功后执行 `systemctl reload nginx`，服务状态为 active。

## 发布与回滚信息

- 配置：`/etc/nginx/conf.d/sanjie.conf`
- 配置备份：`/etc/nginx/conf.d/sanjie.conf.pre-auth-redirect-20260906-174736`
- 生效配置 SHA-256：`bc5d83f84ab6c1cf850db977b4d7d4365e8de28e28296608c6a824a19d54b2d0`
- 保持运行的 PM2：`sanjie-self-update-a25eafc80dd2`
- 保持运行的目录：`/opt/sanjie-releases/20260906-self-update-a25eafc80dd2`
- 端口：3040；PID：2096477；修复前后相同，状态 online。
- 本次没有应用发布、数据库迁移、模型设置或历史数据变更。

紧急回滚时，先保存当时配置并确认没有后续变更，再从上述备份恢复，执行 `nginx -t` 后平滑重载。恢复旧配置会重新引入本次登录跳转错误，不应在无替代修复时执行。

## 验证证据

15 项不跟随跳转的 HTTP 检查通过：主域首页、tools、tutorials、dashboard；www 首页和 tools；query 和无效分享路径 returnTo；login、privacy、登录 JS；匿名 auth/me；RSC、x-nextjs-data；HTTP→HTTPS。

三项完整跳转链通过：主域首页、www 首页、tools 均为一次跳转，最终 `200 https://shaozhuangai.com/login`。www 完整链首次探测曾遇到客户端 TLS 握手超时，复测成功；此前 www 的两个响应头检查均已成功。不得将此次探测描述为对所有网络环境的持续可用性保证。

Chrome 复用既有登录状态从官网首页进入经营网络页，页面已完整加载。未退出或改动用户登录状态，也未提交登录表单。

## 本地源码修复（尚未发布到当前生产应用）

本地 `src/lib/auth-redirect-url.ts` 提供 Edge 兼容的认证 origin 校验：生产默认官网域名，显式配置使用经过校验的 PUBLIC_APP_ORIGIN；忽略入站 Host/Forwarded；开发保留本地 origin。middleware 的未登录、角色越权两处分支已采用该 helper，并保留 query、returnTo 和权限逻辑。

新增代理场景回归，包括 localhost:3040、恶意 Host、两处分支、参数、生产无效配置、开发、401 和放行行为。相关 5 组测试共 65 项通过；全仓 `tsc --noEmit --incremental false` 通过；修改文件 diff 检查通过。

本地 checkout 包含其他并行未提交工作，且版本早于今日生产自更新版本，因此没有用该 checkout 整仓发布。下一次应用发布须在最新生产对应源码中包含 middleware 与新增 helper；部署文档已同步代理规则和完整 Location 验收标准。当前公网访问恢复由已上线的 Nginx 修复保证。
