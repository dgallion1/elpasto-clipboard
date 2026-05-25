# Go Backend

This module now serves both the API and the packaged frontend in production.

Production cache policy for the packaged frontend:

- `GET /` and `GET /{token}` return HTML with `Cache-Control: no-store`
- `GET /_next/static/*` returns fingerprinted assets with `Cache-Control: public, max-age=31536000, immutable`
- `GET /__elpasto/version` returns a no-store build marker used by long-lived tabs to detect deploys and trigger a full reload

## Run

```bash
cd backend
go run ./cmd/elpasto
```

Default port: `3000`

For split frontend/backend development:

```bash
# Terminal 1
cd backend
PORT=8080 go run ./cmd/elpasto

# Terminal 2
cd ..
npm run dev
```

`next.config.ts` proxies `/api/*` to `http://127.0.0.1:${GO_BACKEND_PORT:-8080}` during development.

## Build

From the repo root:

```bash
make build
```

This runs `next build`, packages the frontend into `backend/internal/frontend/dist`, and compiles the final Go binary.

On startup, the server restores `DATA_DIR/snapshot.json` so sessions survive restarts. Clip payloads travel peer-to-peer via WebRTC and never touch the server.

## Test

```bash
cd backend
go test ./...

# Package-local coverage profile
go test ./... -coverprofile=coverage.out
go tool cover -func=coverage.out

# Full cross-package coverage profile
go test ./... -coverpkg=./... -coverprofile=coverage.out
go tool cover -func=coverage.out

# Tunnel CLI package
go test ./cmd/elpasto-tunnel
```

Tests use real handlers, `httptest`, temp directories, and the in-memory store rather than mocks.

Coverage snapshot from April 6, 2026:

- `93.5%` total statement coverage from `go test ./... -coverprofile=coverage.out`
- `82.4%` total statement coverage from `go test ./... -coverpkg=./... -coverprofile=coverage.out`
- `56.7%` statement coverage for `./cmd/elpasto-tunnel` after adding direct tests for CLI parsing, `main()`, and browser-command selection
- `98.1%` statement coverage for `./internal/frontend` after adding a direct test for the embedded `Handler()` wrapper

## API Surface

Session access is possession-based: clients create a session, share the session
URL or token, and re-open that session directly. The backend does not require a
separate shared-password step for default session entry.

- `GET /api/health`
- `POST /api/sessions`
- `GET /api/sessions/lookup?prefix=word1-word2-word3`
- `GET /api/sessions/{token}`
- `GET /api/sessions/{token}/events`
- `POST /api/sessions/{token}/signal`
- `GET /api/auth/tunnel/start`
- `GET /api/auth/tunnel/callback`

The same process also serves:

- `GET /`
- `GET /{token}`
- `GET /_next/static/*`
- `GET /__elpasto/version`

The frontend route handler only treats valid 5-word session tokens as token pages. Injected token values are JSON-escaped before replacement into the packaged `token.html` shell to avoid turning the route into an inline-script XSS sink. The packaged HTML also carries a build marker so the browser can detect a newer embedded frontend and reload cleanly after deploys.

`/api/sessions/{token}/events` is an SSE endpoint carrying:

- `session:expired`
- `peer:signal`

`POST /api/sessions/{token}/signal` accepts a JSON body with `fromPeerId`, `signalType`, and optional `toPeerId`. The server validates the session and republishes the payload to all SSE subscribers on that token.

The server does not store customer clip payloads in the current architecture. Browsers use `/api/sessions/{token}` for session metadata and `/api/sessions/{token}/signal` plus SSE for WebRTC rendezvous; clip bytes and text payloads stay client-side.

## Environment Variables

- `PORT`
- `DATA_DIR`
- `SESSION_EXPIRY_HOURS`
- `MAX_CLIP_BYTES`
- `MAX_SESSION_BYTES`
- `MAX_CLIPS_PER_ZONE`
- `RATE_LIMIT_CREATE_PER_HOUR`
- `RATE_LIMIT_LOOKUPS_PER_MINUTE`
- `RATE_LIMIT_UPLOADS_PER_MINUTE`
- `CLEANUP_INTERVAL_MS`
- `GOOGLE_OAUTH_CLIENT_ID` — Google OAuth client ID for tunnel auth gate (feature disabled when unset)
- `GOOGLE_OAUTH_CLIENT_SECRET` — Google OAuth client secret
- `TUNNEL_AUTH_SECRET` — HMAC secret for minting tunnel auth tokens (`ept_...`, 30-day TTL)
- `TUNNEL_AUTH_ALLOWED_EMAILS` — comma-separated allowed Google emails
- `TUNNEL_AUTH_ALLOWED_DOMAINS` — comma-separated allowed Google email domains
- `RATE_LIMIT_TUNNEL_AUTH_STARTS_PER_HOUR` (default 10)
- `RATE_LIMIT_TUNNEL_AUTH_CALLBACKS_PER_HOUR` (default 30)



## Tunnel Auth Gate

When `GOOGLE_OAUTH_CLIENT_ID` is set, the `elpasto-tunnel` CLI must authenticate via Google OAuth before registering a server-relay tunnel. The CLI opens a browser for OAuth on first use and caches the resulting token at `~/.config/elpasto/tunnel-token` (0600 permissions).

- Routes: `GET /api/auth/tunnel/start` (initiates OAuth), `GET /api/auth/tunnel/callback` (exchanges code for token)
- Token format: `ept_<base64url(json claims)>.<hmac-sha256 sig>`, 30-day TTL
- If any tunnel-auth env var is set, all required vars (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `TUNNEL_AUTH_SECRET`) must be present — the server fails at startup otherwise
- Allowed identities are controlled via `TUNNEL_AUTH_ALLOWED_EMAILS` and `TUNNEL_AUTH_ALLOWED_DOMAINS`
- 401/403 from `/api/tunnel/ws` does NOT trigger WebRTC fallback in the CLI (prevents auth bypass)
- Session creation, clipboard sync, and normal browser usage are unaffected
