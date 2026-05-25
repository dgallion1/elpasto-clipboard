# elPasto — Project Instructions

## Stack
- Next.js 15 (App Router) + TypeScript (strict) + Tailwind CSS v4
- Single Go binary serves API + embedded frontend (no Node.js in production)
- In-memory store with snapshot persistence (survives crashes/restarts), SSE for signaling
- WebRTC data channels + IndexedDB for peer-local clip transfer and persistence
- Go 1.26 backend under `backend/`

## Dev
- `make dev` starts Next.js dev (:3000) + Go backend (:8080) together; override with `make dev PORT=3001`
- Next.js rewrites `/api/*` to Go backend in dev (configured in `next.config.ts`)
- SSE connects directly to Go backend in dev via `NEXT_PUBLIC_GO_BACKEND_PORT` to bypass Next.js proxy buffering; the Makefile passes this automatically — no `.env` file needed for dev
- CORS in dev mode allows any `http://localhost:*` origin so SSE works regardless of which port Next.js uses
- `make build` builds frontend assets + Go binary for production
- Type-check: `npx tsc --noEmit`
- Lint: `npm run lint`
- Test: `npm test` or `npx vitest run`; frontend tests use `@testing-library/react` with jsdom
- Go tests: `cd backend && go test ./...` or `make go-backend-test`
- Go quality: `make go-check` (vet → staticcheck → govulncheck → test → race)
- Go coverage: `cd backend && go test ./... -coverpkg=./... -coverprofile=coverage.out && go tool cover -func=coverage.out`
- Pre-commit hook runs `make check` (type-check + lint + vitest + full Go pipeline)
- Prefer real handler/store/tempdir tests over heavy mocking
- Data stored in `./data/` (gitignored)

## Deployment
- Single Docker image runs the Go binary on port 3000 (mapped via `DOCKER_PORT`, default 3001).
- Deploy via `make docker-deploy` (rsync + remote `docker compose up -d`); host/path/SSH come from `deploy.local.mk` (gitignored — copy `deploy.local.mk.example` to start).
- Optional coturn TURN relay runs as a second Docker service via `make docker-deploy-turn` and the `turn` compose profile. Pass `TURN_REALM` and `TURN_EXTERNAL_IP` via `deploy.local.mk`.
- TLS termination is upstream (reverse proxy or tunnel of your choice).
- All env vars must be listed in `docker-compose.yml` `environment:` section.
- `make tunnel-all` cross-compiles the tunnel CLI.

## Security
- Clip payloads never touch the server — content stays in browsers via WebRTC
- No user accounts, no stored clipboard content on server
- Proxy headers ignored unless `TRUST_PROXY_HEADERS=true`
- Rate limiting on all public endpoints; per-IP counters self-clean on disconnect
- Tunnel URLs are capability URLs (wrong tokens → 404, not 401/403)
- Tunnel auth gate: server-relay tunnels require Google OAuth when configured; rejection does NOT fall back to WebRTC
- Request logging redacts session and tunnel tokens with `[REDACTED]`
- See `Security` comments in code and `docs/security-review-2026-03-28.md` for details

## Data Residency
- **Server**: session metadata, visitor stats, ephemeral signaling, rate-limit counters; tunnel relay passes through but is not persisted
- **Browser only**: all clip content, encryption keys, peer names, session history, binary data, tombstones, paranoid-mode keys (localStorage/sessionStorage/IndexedDB)

## Conventions
- Client code in `lib/` and `hooks/`; components in `components/`; API routes in `backend/internal/api/`
- Realtime split: `useRealtimeSession.ts` (SSE) and `usePeerMesh.ts` (WebRTC mesh)
- Expiry checked inline on every request — never rely on cleanup job alone
- Two encryption modes: normal (AES-GCM, sessionStorage) and paranoid (HKDF-SHA256 v2, IndexedDB CryptoKey); `SecretHandle` union type routes through pipeline; paranoid mode is a checkbox toggle in the secret prompt, not a separate button
- File clips support optional plain-text notes (`clip.note`); notes flow through DirectClipEnvelope, IndexedDB, and peer catalog offers
- Dropped folders are auto-zipped client-side via `fflate` (`lib/zip-folder.ts`) into a single `.zip` clip
- Notification sounds on incoming clips (`hooks/useNotificationSound.ts`); 5 Web Audio synthesized sounds (droplet, chirp, duo, bell, brush), 3-step volume (low 0.15/medium 0.4/high 0.8 gain), compact dropdown picker in header (`components/SoundDropdown.tsx`); state persisted in localStorage, cross-tab sync via `storage` events
- Image clips are click-to-zoom: thumbnail in card (`max-h-48`), click opens full-size lightbox overlay (`components/ImageLightbox.tsx`); dismiss via click, backdrop click, or Escape; works for both plain and encrypted images
- Zip file clips can preview embedded images and rendered PDF pages before download via `useZipImagePreviews` + `lib/zip-images.ts` + `lib/zip-pdf.ts`; extraction is bounded (512 MB source cap, 8 MB per-entry cap, 24 MB total inflated preview budget, max 20 rendered preview items), and duplicate basenames fall back to full archive paths so carousel/lightbox labels remain distinct
- Standalone PDF file clips render page previews in the same carousel as zip images via `usePdfPreviews` + `lib/zip-pdf.ts`; up to 20 pages rendered at 1.5x scale, same 512 MB source cap; reuses `ZipImageCarousel` for display
- Sender text/html clips are editable inline: click content to enter textarea, save on blur or Ctrl/Cmd+Enter, cancel on Escape; edits propagate to peers via `clip:update` control message with `replaceExisting` transfer semantics; HTML clips keep `kind: "html"` and regenerate safe HTML from edited plaintext (`lib/html-utils.ts`)
- Deletion tombstones prevent clip resurrection in peer mesh (session-scoped, 500-entry FIFO, IndexedDB); tombstones propagate to late-joining peers via `clip:delete` on catalog offer
- Dynamic threads replace fixed A/B zones: `ClipZone` is now `string` (was `"A" | "B"`); thread metadata (`lib/threads.ts`) is client-owned with peer sync via WebRTC control messages (`threads:sync`, `thread:created`, `thread:renamed`, `thread:deleted`, `thread:reordered`); max 10 active threads per session; thread tombstones (50-entry cap) prevent stale peer resurrection; thread names/positions persist in localStorage per session; legacy `"A"`/`"B"` zone IDs are valid thread IDs — no migration needed; the wire/persisted field name stays `zone` in v1
- Mobile: fixed bottom tab bar switches threads; desktop: single active thread with tab bar

## Design

### Users
People moving text, files, or images between their own devices or sharing with someone nearby. Quick, task-oriented, mid-workflow. No accounts, no setup.

### Aesthetic
- Dark-only (neutral-950 base), Linear-inspired — dark, fast, keyboard-aware, polished
- Neutral grays base; semantic accents: emerald (active), blue (primary), red (danger), amber (warnings), sky (tunnel)
- System fonts + monospace for tokens/IDs

### Principles
1. **Invisible until needed** — Controls surface on hover/focus, not by default
2. **Speed is a feature** — Fewer elements, less layout shift, optimistic UI over spinners
3. **Trust through clarity** — Privacy shown through design, not badges
4. **Functional density** — Monospace tokens, status dots, inline actions
5. **Dark-first, contrast-aware** — WCAG AA ratios, semantic color only
