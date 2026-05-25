# syntax=docker/dockerfile:1.6
FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @copilot/web exec prisma generate
RUN pnpm --filter @copilot/web build

FROM node:20-bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/prisma ./apps/web/prisma
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/web
CMD ["pnpm", "exec", "tsx", "src/server/queue/worker.ts"]

FROM base AS migrator
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/web
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
