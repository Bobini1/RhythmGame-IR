FROM oven/bun:1.3.14-alpine AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine AS runtime

LABEL org.opencontainers.image.title="RhythmGame Arena Server" \
      org.opencontainers.image.description="Ephemeral RhythmGame Arena protocol 1.2 competition server"

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    INVENTORY_UPLOAD_TIMEOUT_MS=60000 \
    MAX_PENDING_INVENTORY_BYTES=134217728 \
    MAX_COMMITTED_INVENTORY_BYTES=536870912 \
    MAX_ROOMS=1000 \
    MAX_CONNECTIONS=5000 \
    TELEMETRY_INTERVAL_MS=200

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD ["bun", "-e", "const port = Bun.env.PORT ?? '3001'; const response = await fetch(`http://127.0.0.1:${port}/healthz`); if (!response.ok) process.exit(1);"]
CMD ["bun", "src/main.ts"]
