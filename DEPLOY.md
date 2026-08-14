# 部署指南（阿里云 ECS · Alibaba Cloud Linux 3 · 命令行）

## 生产发布保护（必须先执行）

- 唯一生产工程：`/Users/shaozhuang/20260606sanjie`。`/Users/shaozhuang/Desktop/20260606sanjie` 仅是历史副本，禁止整仓发布。
- 普通公开工具插件仍放在 `public/downloads/`；达摩盘付费插件必须放在 `private-assets/dmp/`，并通过 `/api/tools/dmp/download` 的登录与数据库授权校验下载，禁止复制回 `public/`。管理员每次开通或续费默认授予 30 天，到期后下载、插件运行和 JSON 入口自动关闭。
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
ENV
```

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
server {
    listen 80;
    server_name _;            # 有域名就填域名
    client_max_body_size 20m; # 允许上传源数据表
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
