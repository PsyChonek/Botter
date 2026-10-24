# Botter in a container: headless Chromium with the extension loaded and a
# login-protected dashboard on port 8080 to set it up and watch it.
# The base image version must match playwright-core in server/package.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

ENV NODE_ENV=production \
    PORT=8080 \
    EXTENSION_DIR=/app/extension \
    PROFILE_DIR=/data/profile

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/public ./public
COPY manifest.json /app/extension/
COPY _locales /app/extension/_locales
COPY src /app/extension/src

RUN mkdir -p /data/profile && chown -R pwuser:pwuser /data
USER pwuser
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.mjs"]
