# RemoteDesk 中继服务器 — 部署指南

## 方案对比

| 平台 | 免费额度 | WebSocket支持 | 长期可用 | 难度 |
|------|---------|--------------|---------|------|
| Railway | 每月$5 credits | ✅ 原生 | ✅ 持续运营 | ⭐ 简单 |
| Fly.io | 每月$5 credits | ✅ Docker容器 | ✅ 持续运营 | ⭐⭐ 中等 |
| Render | 免费但服务会休眠 | ✅ | ⚠️ 免费版会休眠 | ⭐⭐ 中等 |
| Ably (SaaS) | 3M消息/月 | ✅ | ✅ 商业产品 | ⭐ 简单但非自建 |

**推荐 Railway**：Node.js 原生支持、git push 自动部署、免费额度足够、永久在线。

---

## 方式一：Railway 网页部署（推荐，无需 CLI）

### 步骤

1. 打开 https://railway.app 注册/登录（支持 GitHub 账号）
2. 点击 **New Project** → **Deploy from GitHub repo**
3. 如果代码不在 GitHub，先：
   - 打开 https://github.com/new 创建新仓库
   - 把 `relay-deploy/` 目录下的文件推送上去
   - 或者在 Railway 网页上直接上传代码包
4. Railway 会自动检测到 `package.json`，选择 **Node** 模板
5. 点击 **Variables** 添加：
   - `PORT` = `8080`（Railway 要求）
6. 点击 **Deploy**，等待部署完成
7. 部署后会得到一个域名如 `https://your-app.up.railway.app`
8. 记下这个域名，更新手机 APK 中的中继地址

### 更新 APK 中继地址

修改 `android/app/build.gradle.kts` 和 `android/controller/build.gradle.kts` 中的 `RELAY_HOST`，然后重新编译 APK。

---

## 方式二：使用 Railway CLI（已有 GitHub 仓库时）

```bash
# 安装 CLI（Windows）
npm install -g @railway/cli

# 登录
railway login

# 进入项目目录并初始化
cd remotedesk/relay-deploy
railway init

# 连接你的 Railway 项目
railway link

# 设置环境变量
railway variables set PORT=8080

# 部署
railway up
```

---

## 方式三：Fly.io 部署（Docker）

如果需要更稳定的长期运行，可以部署到 Fly.io：

```bash
# 安装 fly CLI
# https://fly.io/docs/hands-on/install-flyctl/

fly launch --no-deploy
# 编辑 fly.toml，确保：
#   [http_service]
#     internal_port = 8080
#     force_https = true

fly deploy
```

对应的 `Dockerfile`：
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

---

## 当前可用中继（临时）

`wss://remotedesk-relay.app.workbuddy.host/host`
`wss://remotedesk-relay.app.workbuddy.host/controller`

⚠️ 这是 WorkBuddy 临时 pod，不保证长期可用。建议迁移到自有中继。
