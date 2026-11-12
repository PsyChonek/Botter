# Botter in a container: the bot runs in Node for every saved account against
# the casino API, and a login-protected dashboard on port 8080 controls it.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    BOT_DIR=/app/bot \
    DATA_DIR=/data

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY server/public ./public
COPY _locales /app/bot/_locales
COPY src /app/bot/src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.mjs"]
