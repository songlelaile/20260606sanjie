# 三阶引擎边缘防护配套

这是待审查、待部署的 Nginx 配置片段。文件存在或本地测试通过，不代表网站已经启用。它提高公开源码与敏感文件的获取门槛、压制登录/注册突发请求；浏览器必须接收到的界面和 JavaScript 仍可能被观察或复制，也无法可靠区分 Codex 电脑操作和真人操作。

## 合入现有配置

在现有 `http {}` 内只引入一次 `anti-clone-http.conf`，在所有面向公网的对应 `server {}` 内引入 `anti-clone-server.conf`。例如将文件复制到已审查的路径后：

```nginx
http {
    include /etc/nginx/security/anti-clone-http.conf;
    # 保留现有配置
    server {
        # 保留现有 listen、证书与 server_name
        include /etc/nginx/security/anti-clone-server.conf;
        # 保留现有 locations
    }
}
```

片段在 server rewrite 阶段判断经过 Nginx 规范化的 `$uri`，返回 `404`；`/_next/` 或 `/downloads/` 使用 `location ^~` 时也不会绕过 `.map`、`.env`、版本库、证书私钥、数据库与备份文件拦截。将 server include 放在可能提前结束请求的现有 `return` / `rewrite` 前。不要为这些规则重新创建或替换现有静态、上传、下载、模型代理或 WebSocket location。

登录仅对 `POST /api/auth/login` 每 IP 每分钟 30 次、额外突发 10 次限流；注册使用独立预算，每分钟 6 次、额外突发 3 次。超额返回 `429`。普通页面、图片、同源 iframe、合法 JavaScript 和 ZIP 更新不消耗这两个预算。参数应结合上线后的共享办公网络流量审查。location 内若已有 `limit_req`，Nginx 不会继承 server 级规则，需要在该 location 保留原规则并合入这两条规则及 `limit_req_status 429`。应用层的数据库限流仍是多实例、账号级保护的必要部分。

## 可信客户端 IP

**必须逐个合入所有向 Next.js 或模型代理转发的现有 location。** 将同名旧指令替换为下列值，保留其它 `Host`、协议、升级连接和业务头设置。不要只把这些指令放在 server 级：location 内任意 `proxy_set_header` 都会取消父级整组头配置的继承。

```nginx
# Apply inside every existing proxy location
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header Forwarded "";
```

这样客户端伪造 `X-Real-IP`、`X-Forwarded-For` 或 `Forwarded` 不会成为应用的可信身份。应用服务只应监听回环/私网接口，安全组不可把 Next.js 端口直接暴露到公网；否则请求可能绕过 Nginx 与这些覆盖规则。不要为防抄袭更改现有 upstream 重试策略；本片段没有 `proxy_next_upstream` 指令。

如果公网前还有 CDN/WAF/负载均衡，必须先核对真实链路：仅把实际代理的精确 CIDR 加入 `set_real_ip_from`，选择该代理官方规定的 `real_ip_header` 并核对 `real_ip_recursive`。这样 `$remote_addr` 才能代表真实客户端。不能信任 `0.0.0.0/0`、`::/0` 或未经核实的来源；也不能直接用请求提供的 IP 头作为限流键。这个仓库片段没有猜测生产代理 CIDR。若未配置正确，所有客户可能被当成同一个 CDN IP。

## 下载与验收边界

这两份配置**不会**把旧 `/downloads/*.zip` 自动改成登录后下载。旧 ZIP 的匿名暴露必须由应用下载路由、私有文件存放及旧地址迁移修复；已登录更新流程、插件自动更新文件和旧版本地址需要分别验收。不能仅封禁所有 ZIP，或在 Nginx 中检查一个 cookie 的存在便当成用户已经授权。普通图标、插件更新元数据和更新资源应保留其经过审查的访问规则。

没有按 User-Agent（包括 Codex）、鼠标速度、DevTools 或截图工具封禁，也没有植入针对访问者电脑的控制行为。网页不能保证阻止已获授权访客通过屏幕观察功能。账号授权、服务端核心逻辑和资源最小暴露仍承担主要保护。

本地检查命令：

```sh
node scripts/test-security-nginx.mjs
```

脚本使用临时配置及回环端口运行本机 Nginx，先执行 `nginx -t`，再验证敏感路径、编码路径、`^~` 静态旁路、IP 头伪造、两个独立限流区与正常资源不受影响。不读取或改写现有 Nginx 配置，不 reload 现有进程，也不请求生产网站。若本机缺少 Nginx，会明确输出未验收并以状态码 `2` 退出；可用 `SECURITY_NGINX_BIN=/path/to/nginx` 指定已有二进制。

上线时仍需核对真实完整配置（含所有 listener、location、real-IP 链和直连端口），保存回滚文件，用生产的 `nginx -t` 验证后按部署流程 reload，并验收登录、注册、主图/详情 iframe、图片上传、代理、插件安装及更新。当前模板检查不证明这些生产链路已经通过。

指令依据仅使用 Nginx 官方文档：[请求限流](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)、[map](https://nginx.org/en/docs/http/ngx_http_map_module.html)、[规范化 URI 和 location](https://nginx.org/en/docs/http/ngx_http_core_module.html#location)、[proxy_set_header 继承](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)、[可信 real-IP 来源](https://nginx.org/en/docs/http/ngx_http_realip_module.html)。
