FROM node:22-alpine AS frontend

WORKDIR /app
RUN apk add --no-cache curl
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY next.config.ts tsconfig.json postcss.config.mjs ./
COPY app/ app/
COPY components/ components/
COPY hooks/ hooks/
COPY lib/ lib/
COPY scripts/ scripts/
COPY public/ public/
COPY backend/internal/frontend/dist/. backend/internal/frontend/dist/
ARG NEXT_PUBLIC_CF_ANALYTICS_TOKEN=""
ENV NEXT_PUBLIC_CF_ANALYTICS_TOKEN=$NEXT_PUBLIC_CF_ANALYTICS_TOKEN
ARG NEXT_PUBLIC_PLAUSIBLE_ENABLED=""
ENV NEXT_PUBLIC_PLAUSIBLE_ENABLED=$NEXT_PUBLIC_PLAUSIBLE_ENABLED
RUN npm run build
RUN sh scripts/build-frontend.sh

FROM golang:1.26-alpine AS builder

WORKDIR /app/backend
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend ./
COPY --from=frontend /app/backend/internal/frontend/dist ./internal/frontend/dist
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -o /out/elpasto ./cmd/elpasto

RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    mkdir -p /out/downloads && \
    for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do \
        os=${target%/*}; \
        arch=${target#*/}; \
        ext=""; \
        if [ "$os" = "windows" ]; then ext=".exe"; fi; \
        echo "Building elpasto-tunnel-${os}-${arch}${ext}"; \
        CGO_ENABLED=0 GOOS=$os GOARCH=$arch \
          go build -o /out/downloads/elpasto-tunnel-${os}-${arch}${ext} ./cmd/elpasto-tunnel & \
    done && wait

FROM alpine:3.21 AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

RUN addgroup --system --gid 1001 elpasto && \
    adduser --system --uid 1001 --ingroup elpasto elpasto && \
    mkdir -p /data && chown elpasto:elpasto /data

COPY --from=builder /out/elpasto /usr/local/bin/elpasto
COPY --from=builder /out/downloads /downloads
ENV DOWNLOADS_DIR=/downloads

USER elpasto
EXPOSE 3000

CMD ["elpasto"]
