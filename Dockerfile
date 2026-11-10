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
# 「今天」「上个月」「去年10月」按哪个时区算。容器默认 UTC，不设的话
# 东八区用户问「上个月」会从北京时间 1 号早上 8 点算起。用标准 TZ，
# 容器里 date、日志、第三方库的本地时间也跟着对齐；换时区就覆盖这一个变量。
ENV TZ=Asia/Shanghai

# alpine 不带 tzdata，此时系统级时区会退回 UTC（应用自己走 Intl 不受影响，
# 但日志和 date 命令会显示 UTC，排查时容易看错）。
RUN apk add --no-cache tzdata \
 && mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 8006
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8006}/api/setup-status" >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
