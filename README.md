# elPasto

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Self-hostable, end-to-end-encrypted clipboard for moving text, files, and images
between your own devices over WebRTC. No accounts. No server-side storage of
clipboard content.

## Features

- **Peer-to-peer** — clip payloads travel directly between browsers over WebRTC.
  The server only relays signaling and session metadata.
- **Capability URLs** — a session is a 5-word URL like `/elk-piano-river-frost-bloom`.
  Anyone with the URL can join; nobody else can.
- **Multi-modal clips** — text, formatted HTML, images, files, folders (auto-zipped),
  and PDFs (with rendered page previews).
- **Encrypted at rest in the browser** — clips persist to IndexedDB under an AES-GCM
  key (normal mode) or a non-extractable HKDF-SHA256 CryptoKey (paranoid mode).
- **Mobile-friendly** — bottom tab bar for threads, native OS paste, QR-code session
  handoff.
- **Self-contained Docker deploy** — single image, embedded frontend, optional
  coturn TURN relay for clients behind symmetric NAT.

## Quickstart

Prerequisites:

- Docker + Docker Compose for the container path.
- Node.js 22+, npm, Go 1.26+, and `make` for local development without Docker.

```bash
git clone https://github.com/your-org/elpasto.git
cd elpasto
cp .env.example .env             # safe placeholders — no required edits to boot
docker compose up -d --build
open http://localhost:3000       # or http://your-host:3000
```

That gets you a working local instance. To run elpasto in development without
Docker:

```bash
npm install
make dev                         # Next.js dev (:3000) + Go backend (:8080)
```

If `make` is not available, run the two processes separately:

```bash
npm run dev
cd backend && PORT=8080 go run ./cmd/elpasto
```

Build the embedded production binary:

```bash
make build                       # outputs backend/elpasto
make tunnel-all                  # cross-compile the tunnel CLI for all platforms
```

## Configuration

Every setting is an environment variable. The full surface is documented in
[`.env.example`](./.env.example); the most common ones to touch:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the container listens on (host-side mapping is set in `Makefile`) | `3000` |
| `DATA_DIR` | Where session metadata and snapshots persist | `/data` |
| `NODE_ENV` | `production` enables HSTS + stricter CORS | _unset_ |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins allowed in production | _empty_ |
| `TRUST_PROXY_HEADERS` | Honor `X-Forwarded-For` (only behind a trusted reverse proxy) | `false` |
| `SESSION_EXPIRY_HOURS` | How long sessions live | `24` |
| `TURN_SECRET` / `TURN_SERVER` | Enable TURN relay for clients behind symmetric NAT | _empty (disabled)_ |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `TUNNEL_AUTH_SECRET` | Required to enable server-relay tunnels via the `elpasto-tunnel` CLI | _empty (disabled)_ |
| `STATS_DASHBOARD_KEY` | Gate for `/api/stats` and `/stats` page (404 without it) | _empty (disabled)_ |
| `NEXT_PUBLIC_CF_ANALYTICS_TOKEN` | Build-time Cloudflare Web Analytics token | _empty (disabled)_ |
| `PLAUSIBLE_SCRIPT_URL` / `PLAUSIBLE_EVENT_URL` | Plausible analytics proxy URLs | _empty (disabled)_ |

## Architecture

A single Go binary serves the API and the embedded Next.js frontend. Sessions live
in-memory with snapshot persistence to disk (so the binary survives restarts).
SSE delivers WebRTC signaling and session-state updates. Two browsers connect
peer-to-peer via WebRTC data channels for actual clip transfer.

```
Browser A  ──signaling (SSE+POST)──▶  Go binary  ◀──signaling──  Browser B
   └──────────────────────── WebRTC data channel ────────────────────────┘
                              (clip payloads only)
```

The server never sees clip content. Clips persist locally to each browser's
IndexedDB. See [`docs/architecture.md`](docs/architecture.md) for the data-flow
diagram and the encryption-mode details.

## Security model

- **Clip payloads never touch the server.** Content stays in browsers via WebRTC.
- **No user accounts. No stored clipboard content.**
- **Capability URLs**: wrong-token requests return `404`, not `401/403`, to avoid
  enumerating valid sessions.
- **Rate limiting** on all public endpoints, per-IP, with self-cleaning counters.
- **Optional Google-OAuth gate** on server-relay tunnels (`TUNNEL_AUTH_SECRET` +
  `GOOGLE_OAUTH_CLIENT_*`); rejection does **not** fall back to WebRTC.
- **Request logs redact** session and tunnel tokens with `[REDACTED]`.

See [`docs/security-review-2026-03-28.md`](docs/security-review-2026-03-28.md) for
the full security review and [SECURITY.md](SECURITY.md) to report vulnerabilities.

## Development

```bash
make dev          # Next.js dev (:3000) + Go backend (:8080)
make check        # tsc + ESLint + Vitest + Go vet/staticcheck/govulncheck/test/race
make build        # full production build
```

Run only the Go backend test pipeline:

```bash
make go-check
```

Tests:

- Frontend: [Vitest](https://vitest.dev) with `@testing-library/react` + jsdom.
- Backend: standard `go test`, with `-race` and `govulncheck` in CI.

The `make check` Git pre-commit hook is recommended for contributors. See
[`CLAUDE.md`](CLAUDE.md) for the in-repo project-conventions reference.

## Secrets and local files

This repository is intended to be usable without private credentials. Optional
integrations such as TURN, Google OAuth tunnel auth, stats, and analytics are
disabled when their env vars are blank.

- Copy `.env.example` to `.env` for local values. `.env*` files are ignored.
- Copy `deploy.local.mk.example` to `deploy.local.mk` for deployment values.
  `deploy.local.mk` is ignored.
- Do not commit generated runtime data from `data/`, built frontend assets from
  `backend/internal/frontend/dist/`, or tunnel binaries from `backend/downloads/`.
- Before publishing a fork, run a secret scan over the current tree and the Git
  history if the repository has ever contained private deployment values.

## Deployment

The provided `docker-compose.yml` boots elpasto on a single host. To deploy to a
remote server, copy `deploy.local.mk.example` to `deploy.local.mk` and set:

```makefile
DEPLOY_HOST = your.host.example
DEPLOY_PATH = ~/elpasto
SSH = ssh                # or "tailscale ssh" if the host is on Tailscale
```

Then:

```bash
make docker-deploy              # rsync sources + remote docker compose up
make docker-deploy-turn         # same, with coturn TURN relay enabled
```

The `Makefile` deploy targets stay generic; everything personal lives in your
local `deploy.local.mk` (gitignored). TLS termination is upstream — front this
with your reverse proxy or tunnel of choice.

For TURN: open UDP/TCP 3478 + UDP 49152-49200 on your router, point a DNS A
record at the host, then set `TURN_SECRET`, `TURN_SERVER`, `TURN_REALM`, and
`TURN_EXTERNAL_IP` in `deploy.local.mk` (the `make docker-deploy[-turn]`
targets forward all four over SSH to the remote `docker compose`).

## License

[MIT](LICENSE)
