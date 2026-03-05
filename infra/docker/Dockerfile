FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=1

RUN npm install -g pnpm@10.6.3

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY market ./market
COPY infra ./infra

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pulsarbot/server build

RUN mkdir -p /runtime/apps/server /runtime/apps/admin /runtime/market \
  && pnpm --filter @pulsarbot/server deploy --prod --legacy /runtime/apps/server \
  && cp -R /app/apps/admin/dist /runtime/apps/admin/dist \
  && cp -R /app/market/. /runtime/market/ \
  && node -e "require.resolve('@fastify/cookie', { paths: ['/runtime/apps/server'] })"

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /runtime/ ./

EXPOSE 3000

CMD ["node", "apps/server/dist/index.js"]
