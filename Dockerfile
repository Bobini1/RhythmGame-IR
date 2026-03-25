FROM oven/bun:latest AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:latest
WORKDIR /app
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/src/lib/server/database/migrations src/lib/server/database/migrations/
COPY --from=builder /app/src/lib/server/database/schemas src/lib/server/database/schemas/
COPY --from=builder /app/drizzle.config.ts drizzle.config.ts
COPY package.json .
EXPOSE 3000
ENV NODE_ENV=production
CMD ["sh", "-c", "bun drizzle-kit migrate && bun build/index.js"]