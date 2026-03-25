FROM oven/bun:latest AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:latest
WORKDIR /app
RUN apt-get update && apt-get install -y curl wget && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/lib/server/database/migrations ./src/lib/server/database/migrations
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY package.json .
EXPOSE 3000
ENV NODE_ENV=production
CMD ["sh", "-c", "bun drizzle-kit migrate && bun build/index.js"]