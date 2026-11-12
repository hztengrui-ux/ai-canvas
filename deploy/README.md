# 阶段 0：单实例可部署版
#
# 这一版只是把「现在这个单机后端」装进容器，数据仍然落在数据卷上（file 存储）。
# 它解决的是「能不能部署到服务器上跑起来」，**不等于**已经多租户上云：
# 多租户、账号/项目进数据库在 phase P1/P2（见 reports/cloud-migration-2026-11-05/云端化方案.md）。
#
# 前置条件：
#   1. 本地已 `npm run build`（镜像要 COPY dist）
#   2. 服务器已装 Docker + Compose v2
#   3. 域名已解析到服务器（Caddy 自动签证书）；国内服务器需先备案

## 1. 准备配置

```bash
cd ai-canvas/deploy
cp .env.example .env
# 编辑 .env：至少把 SITE_ADDRESS 改成你的域名
```

## 2. 构建并启动

```bash
cd ai-canvas
npm run build
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f app
```

看到 `[ai-canvas] server  http://127.0.0.1:5181` 即正常。
浏览器访问 `https://<你的域名>`。

## 3. 必须知道的三个坑

### ① hostname 必须固定（已在 compose 里写死 `hostname: ai-canvas`）
厂商 Key 用「机器特征 + 随机盐」派生的 AES 密钥加密（`server/vault.js:102`，材料 = `os.hostname()` +
用户名 + `COMPUTERNAME` + `USERDOMAIN` + 盐）。
容器每次重建 hostname 变化 → 已保存的 Key **全部解不开**，表现为"设置页显示已配置，但生成时报 Key 无效"。
同理 `/data/.vault-salt` 必须跟数据卷一起持久化。

### ② BIND 必须是 0.0.0.0
`server/index.js:1421` 默认 `127.0.0.1`，容器外访问不到。compose 里已设 `AI_CANVAS_BIND=0.0.0.0`。

### ③ 本机会话令牌的边界
`/api/session` 只对回环地址发令牌（防局域网后门，见 `server/security.js:356`）。
容器里 App 与 Caddy 是两个容器：Caddy 转发进来时 `remoteAddress` 是 docker 网桥地址，**不是** 127.0.0.1，
所以浏览器直接访问会拿不到令牌 → 页面会报"会话已失效"。
阶段 0 的对策：先只做「服务端可用性验证」（curl 健康检查），
面向浏览器的多用户访问必须等 P1 的账号体系（账号登录替代机器令牌）。这也是为什么文档把 P1 排在前面的原因。

## 4. 备份

```bash
# 数据卷整包（含 .vault-salt、secrets/*.enc、users.json、outputs/、materials/）
docker run --rm -v ai-canvas_appdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/ai-canvas-$(date +%F).tgz -C /data .
```
建议每天一次 + 保留 14 天；`secrets/` 与 `.vault-salt` 必须一起备份，缺一不可解密。

## 5. 回滚

`docker compose down` 后把备份解回 `appdata` 卷，再用旧镜像启动即可；数据格式未变。

## 6. 下一步（要真正多用户上云）

按 `reports/cloud-migration-2026-11-05/云端化方案.md` 的 P0→P1→P2：
先做 `server/storage` 适配层 + Postgres，再切账号/会话/项目。
阶段 0 的 compose 里预留了注释位置，届时加 postgres / redis / minio 三个 service。
