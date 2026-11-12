# 跨多多 AI 创作台 · 云端 API 镜像（阶段 0）
# 只装生产依赖，忽略 postinstall（keyring 原生模块在 Linux 容器里不可用时，
# vault 会自动退回「本地加密文件」后端，见 server/vault.js）。
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    AI_CANVAS_HOME=/data \
    AI_CANVAS_BIND=0.0.0.0 \
    PORT=5181 \
    TZ=Asia/Shanghai
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
# 前端产物：先在本地 npm run build，再 docker build（dist 必须存在）
COPY dist ./dist

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 5181

# 探活：/api/session 只对回环发令牌，容器内 127.0.0.1 满足条件
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5181/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
