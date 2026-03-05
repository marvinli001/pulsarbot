FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm@10.6.3

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY market ./market
COPY infra ./infra

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pulsarbot/server build
RUN pnpm prune --prod

RUN mkdir -p /runtime/apps/server /runtime/apps/admin /runtime/packages /runtime/market \
  && cp /app/package.json /app/pnpm-workspace.yaml /runtime/ \
  && cp /app/apps/server/package.json /runtime/apps/server/package.json \
  && cp -R /app/apps/server/dist /runtime/apps/server/dist \
  && cp -R /app/apps/admin/dist /runtime/apps/admin/dist \
  && cp -R /app/market/. /runtime/market/ \
  && for pkg in /app/packages/*; do \
    name="$(basename "$pkg")"; \
    mkdir -p "/runtime/packages/$name"; \
    cp "$pkg/package.json" "/runtime/packages/$name/package.json"; \
    if [ -d "$pkg/dist" ]; then cp -R "$pkg/dist" "/runtime/packages/$name/dist"; fi; \
  done \
  && cp -R /app/node_modules /runtime/node_modules

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /runtime/ ./

EXPOSE 3000

CMD ["node", "apps/server/dist/index.js"]
