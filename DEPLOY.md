# 部署指南（阿里云 ECS · Alibaba Cloud Linux 3 · 命令行）

## 生产发布保护（必须先执行）

- 唯一生产工程：`/Users/shaozhuang/20260606sanjie`。`/Users/shaozhuang/Desktop/20260606sanjie` 仅是历史副本，禁止整仓发布。
- 普通公开工具插件仍放在 `public/downloads/`；达摩盘付费插件必须放在 `private-assets/dmp/`，并通过 `/api/tools/dmp/download` 的登录与数据库授权校验下载，禁止复制回 `public/`。管理员每次开通或续费默认授予 30 天，到期后下载、插件运行、JSON 入口和管理员报告 XLSX 导出自动关闭。
- 每次发布前先运行 `./scripts/predeploy-guard.sh --full`。脚本会阻断错误目录、登录眼睛缺失、明文密码比较、多店铺模型丢失、工具页版本与 ZIP 哈希不一致等回归。
- 每次部署到新的 `/opt/sanjie-releases/<日期-版本>` 目录，先用独立端口做金丝雀验证，再切换 PM2；保留上一版目录用于快速回滚，不在 `/opt/sanjie` 原地覆盖。
- 上线冒烟标准：登录页 200 且有“显示密码”；错误密码返回 401；未登录访问 `/tools` 返回 307；公开新版 ZIP 返回 200；未登录下载达摩盘插件返回 401、未授权账号返回 403；PM2 的 `cwd` 必须是本次新发布目录。

```bash
cd /Users/shaozhuang/20260606sanjie
./scripts/predeploy-guard.sh --full
```

应用 + Postgres 同机一体部署，适用于 ~100 租户。全程用 `root` 或 `sudo`。

> 安全组只放行 22/80/443；**不要**对公网开放 5432(Postgres)。

## 0. SSH 登录

```bash
# 用购买时下载的 .pem 密钥登录（把 IP 换成你的公网 IP）
ssh -i /path/to/your-key.pem root@<公网IP>
```

## 1. Node 20+（若购买时已勾 Nodejs v22 可跳过安装）

```bash
node -v   # 有输出且 >= v18 即可跳过本步
# 没有则装 Node 20 LTS：
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs
node -v && npm -v
```

## 2. 安装并初始化 PostgreSQL

```bash
dnf install -y postgresql-server postgresql
postgresql-setup --initdb
systemctl enable --now postgresql
systemctl status postgresql --no-pager   # active (running) 即可
```

## 3. 建库与账号

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE three_stage_engine;
CREATE USER sanjie WITH PASSWORD '改成你的强密码';
GRANT ALL PRIVILEGES ON DATABASE three_stage_engine TO sanjie;
\c three_stage_engine
GRANT ALL ON SCHEMA public TO sanjie;
SQL
```

## 4. 拉代码 + 安装依赖

```bash
dnf install -y git
cd /opt
git clone -b feat/daily-data-v2 https://github.com/songlelaile/20260606sanjie.git sanjie
cd /opt/sanjie
npm ci      # 会自动 prisma generate（postinstall）
```

## 5. 配置环境变量

```bash
cat > /opt/sanjie/.env <<'ENV'
DATABASE_URL="postgresql://sanjie:改成你的强密码@localhost:5432/three_stage_engine?schema=public"
SESSION_SECRET="改成 openssl rand -hex 32 生成的高强度随机值"
SHARE_ENCRYPTION_KEY="改成另一个 openssl rand -hex 32 生成的高强度随机值"
AI_API_ENCRYPTION_KEY="改成第三个 openssl rand -hex 32 生成的高强度随机值"
PUBLIC_APP_ORIGIN="https://shaozhuangai.com"
ENV
```

`PUBLIC_APP_ORIGIN` 是公开报告链接的唯一规范域名。分享接口不得使用 Next.js 内部端口或请求 `Host` 拼接绝对地址，避免生成 `localhost`、内网域名或反向代理端口链接。

公开报告 HTML 必须由中间件返回 `Referrer-Policy: no-referrer`、`Cache-Control: private, no-store` 和 `X-Robots-Tag: noindex, nofollow`。不能只在埋点 API 上设置：否则浏览器加载同源 `/_next/*` 静态资源时，会把包含 bearer token 的完整报告地址写进 `Referer`，继而可能进入静态资源 access log。

匿名埋点按“先 view、后 click/engagement”接受：客户端会等待 view 事务成功后再发送后续事件，服务端也只有在同一分享、同一匿名访客与同一会话已建立 view 后才累计；活跃秒数按 token/session 保存在浏览器 `sessionStorage` 中，刷新后接着累计，同时限制为服务端 `firstSeenAt` 以来真实经过的墙钟秒数。Nginx 限速仍必须保留，用来抑制随机事件编号持续刷量。

达摩盘插件中的报告表格版 XLSX 属于隐藏管理员能力。插件只能在 `/api/auth/me` 返回 `capabilities.dmpReportExport=true` 时显示入口；用户点击后还必须调用 `POST /api/dmp-report-exports` 实时重验数据库账号、平台管理员角色、DMP 有效期、报告归属和实际报告类型。只有接口返回 HTTP 201 且 `data.authorization.authorized=true` 才能在插件本地生成 XLSX。服务端仅写 `adminId/reportId/reportType/format/clientVersion/exportedAt` 审计元数据，不接收或保存报告 JSON、业务单元格、文件名或导出文件内容。部署新版本时必须先执行 `npm run db:migrate` 创建 `DmpReportExportAudit`，否则审计写入失败会按 503 fail-closed，插件不得继续导出。

## 6. 建表 + 一次性管理员初始化 + 构建

```bash
cd /opt/sanjie
npm run db:migrate    # prisma migrate deploy，建所有表

# 仅首次部署且数据库还没有管理员时执行；密码不会写入仓库或命令历史。
export BOOTSTRAP_ADMIN_USERNAME="填写管理员账号"
read -s BOOTSTRAP_ADMIN_PASSWORD
export BOOTSTRAP_ADMIN_PASSWORD
npm run db:bootstrap-admin
unset BOOTSTRAP_ADMIN_PASSWORD

npm run build         # 生产构建
```

`npm run db:seed` 只用于本地演示，生产环境会直接拒绝执行，也不会再创建或重置公开固定口令。

从旧版切换到独立 `AI_API_ENCRYPTION_KEY` 后，原来用共享密钥保存的店铺 AI Key 不会被自动迁移；请由店铺所有者重新录入一次，避免在迁移脚本或日志中接触明文凭据。

## 7. PM2 守护进程（开机自启）

```bash
npm i -g pm2
cd /opt/sanjie
PORT=3000 pm2 start "npm run start" --name sanjie
pm2 save
pm2 startup systemd -u root --hp /root   # 按提示再执行它输出的那条命令
curl -I http://localhost:3000/login      # 200/307 即应用已起
```

## 8. Nginx 反向代理（80 → 3000）

```bash
dnf install -y nginx
cat > /etc/nginx/conf.d/sanjie.conf <<'NGINX'
limit_req_zone $binary_remote_addr zone=dmp_share_events:10m rate=20r/s;

server {
    listen 80;
    server_name _;            # 有域名就填域名
    client_max_body_size 20m; # 允许上传源数据表

    # 公开报告令牌和访问 IP 不写入 Nginx access log；埋点请求限制为 64KB 并做瞬时限速。
    location ~ "^/shared/dmp-reports/[A-Fa-f0-9]{64}$" {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ "^/api/shared/dmp-reports/[A-Fa-f0-9]{64}$" {
        access_log off;
        client_max_body_size 64k;
        limit_req zone=dmp_share_events burst=40 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
nginx -t && systemctl enable --now nginx
```

发版后用一条真实测试分享验证公开 HTML 响应头（不要把令牌粘贴到工单或群聊）：

```bash
curl -sSI "https://shaozhuangai.com/shared/dmp-reports/<64位测试令牌>" \
  | grep -Ei '^(cache-control|referrer-policy|x-robots-tag):'
# 预期：private, no-store / no-referrer / noindex, nofollow
```

浏览器访问 `http://<公网IP>` → 应看到登录页。使用上一步一次性初始化的管理员账号登录。

## 9.（可选）HTTPS

有域名后，解析到公网 IP，再：

```bash
dnf install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

## 升级发版

```bash
cd /opt/sanjie
git pull
npm ci
npm run db:migrate   # 有新迁移时
npm run build
pm2 restart sanjie
```

## 排错

- 应用起不来：`pm2 logs sanjie`
- 数据库连不上：`sudo -u postgres psql -c "\l"` 看库是否存在；检查 `.env` 密码
- 502：应用没在 3000 跑，看 `pm2 status`
- 上传报错 413：Nginx `client_max_body_size` 调大

## 生产加固（上线前）

- [ ] 生产库不存在 `admin/admin123`、`tenant/tenant123` 等演示账号；不要执行演示 seed
- [ ] `SESSION_SECRET`、`SHARE_ENCRYPTION_KEY`、`AI_API_ENCRYPTION_KEY` 均使用彼此不同的高强度随机值
- [ ] 数据库密码用强密码，且 Postgres 只监听 localhost（默认即是）
- [ ] 定期备份：`pg_dump` 或阿里云快照
- [ ] Nginx 配置 HTTPS 后再对外提供分享链接
