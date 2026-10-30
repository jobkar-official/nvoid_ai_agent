FROM golang:1.27.3-bookworm AS openings-build

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /src/openings-mcp
RUN mkdir -p /out && git clone --depth 1 https://github.com/amikai/openings-mcp.git . \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/openings-mcp ./cmd/openings-mcp

FROM ghcr.io/astral-sh/uv:latest AS uv-bin

FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv-bin /uv /uvx /bin/
COPY --from=openings-build /out/openings-mcp /usr/local/bin/openings-mcp

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV UV_LINK_MODE=copy
ENV UV_CACHE_DIR=/root/.cache/uv

EXPOSE 3100
CMD ["npm", "run", "start:prod"]
