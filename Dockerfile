# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8006
ENV MAILNEST_DATA=/app/data
# 时区不设默认值：镜像不能替全世界决定东八区还是别的。
# 不设 TZ 就是 UTC；要按本地时间解释「今天/上个月/去年10月」，
# 启动时加 -e TZ=Asia/Shanghai（或 compose 里的 environment）。
# 设错了不会崩，日志里会提醒并按 UTC 算。

# alpine 不带 tzdata，装了才能在设 TZ 时让容器里的 date、日志也跟上
# （应用自己走 Intl，本来就不依赖系统时区库）。
RUN apk add --no-cache tzdata \
 && mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 8006
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8006}/api/setup-status" >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
