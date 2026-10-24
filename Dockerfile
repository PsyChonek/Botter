# Botter in a container with no browser: the extension's own scripts run in
# Node against the casino API, and a login-protected dashboard on port 8080
# controls them. No dependencies, nothing to install.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    EXTENSION_DIR=/app/extension \
    DATA_DIR=/data

WORKDIR /app/server
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
COPY manifest.json /app/extension/
COPY _locales /app/extension/_locales
COPY src /app/extension/src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.mjs"]
