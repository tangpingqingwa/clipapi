# Production image. Node 22, non-root, listens on $PORT (default 3000).
# Live TikTok stays off unless the operator sets CLIPAPI_LIVE at runtime.
# Do not bake STRIPE_* secrets or enable CLIPAPI_LIVE in this file.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# tsx is a devDependency; production start is `node --import tsx src/server.ts`.
RUN npm ci && npm cache clean --force

COPY src ./src
COPY tests/fixtures ./tests/fixtures
COPY llms.txt tsconfig.json ./

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    CLIPAPI_DATABASE=/app/data/clipapi.sqlite

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]
