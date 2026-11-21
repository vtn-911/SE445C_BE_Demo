FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    HEALTHCHECK_PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY data ./data
COPY openapi ./openapi

EXPOSE 3000 3100 3200 3300 3500

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HEALTHCHECK_PORT || '3000') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["npm", "start"]
