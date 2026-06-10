# 部署指南（阿里云 ECS · Alibaba Cloud Linux 3 · 命令行）

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
git clone -b feat/postgres-multitenant https://github.com/songlelaile/20260606sanjie.git sanjie
cd /opt/sanjie
npm ci      # 会自动 prisma generate（postinstall）
```

## 5. 配置环境变量

```bash
cat > /opt/sanjie/.env <<'ENV'
DATABASE_URL="postgresql://sanjie:改成你的强密码@localhost:5432/three_stage_engine?schema=public"
ENV
```

## 6. 建表 + 种子 + 构建

```bash
cd /opt/sanjie
npm run db:migrate    # prisma migrate deploy，建所有表
npm run db:seed       # 演示账号 admin/admin123、tenant/tenant123
npm run build         # 生产构建
```

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

浏览器访问 `http://<公网IP>` → 应看到登录页。用 `admin / admin123` 登录。

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

- [ ] 演示账号密码改掉（admin123/tenant123 仅演示）
- [ ] 数据库密码用强密码，且 Postgres 只监听 localhost（默认即是）
- [ ] 定期备份：`pg_dump` 或阿里云快照
- [ ] 账号密码改为加盐哈希（当前为演示明文，见 src/lib/accounts.ts）
