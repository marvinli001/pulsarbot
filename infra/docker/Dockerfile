FROM node:22-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm@10.6.3

WORKDIR /app

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY market ./market
COPY infra ./infra

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "--filter", "@pulsarbot/server", "start"]
