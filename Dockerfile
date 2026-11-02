# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV MAILNEST_DATA=/app/data

RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/setup-status >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
