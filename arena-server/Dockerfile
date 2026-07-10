FROM oven/bun:1.3.14-alpine AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:3001/healthz'); if (!response.ok) process.exit(1);"]
CMD ["bun", "run", "src/main.ts"]
