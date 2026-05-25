# elPasto Security Review

Date: 2026-03-28
Reviewer: Codex (security-focused code review)
Scope: Static review of the `elpasto` app with emphasis on trust boundaries, authn/authz, token handling, tunnel relay surfaces, and exposed operational endpoints.

## Findings

### High: Server-relay tunnel viewer accepts an untrusted iframe URL

- Severity: High
- Files:
  - [app/tunnel-view/[peerId]/[[...path]]/page.tsx](app/tunnel-view/[peerId]/[[...path]]/page.tsx#L22)
  - [app/tunnel-view/[peerId]/[[...path]]/page.tsx](app/tunnel-view/[peerId]/[[...path]]/page.tsx#L105)

#### Issue

When `serverRelay=1` is present, the page reads `window.location.hash`, decodes it, and assigns the result directly to `iframe.src` without validating the scheme, origin, or expected path structure.

#### Impact

A crafted link to `/tunnel-view/{peerId}?serverRelay=1#...` can make the elPasto viewer load attacker-chosen content. At minimum this creates a phishing and open-embed primitive inside a trusted app surface. Depending on browser behavior for iframe URL schemes, it may also permit DOM XSS via dangerous schemes such as `javascript:`.

#### Remediation

- Accept only a narrowly validated relay prefix format.
- Reject non-HTTP(S) schemes and unexpected origins.
- Prefer passing a server-issued opaque viewer token rather than a raw URL capability.
- Keep the fragment-based flow only if the fragment is fully validated before use.

#### Resolution

Fixed. The tunnel viewer now parses the fragment as a `URL` object and rejects any scheme other than `http:` or `https:`, blocking `javascript:`, `data:`, and other dangerous URI schemes.

### Medium: Proxy headers are trusted without constraining the proxy boundary

- Severity: Medium
- Files:
  - [backend/internal/api/helpers.go](backend/internal/api/helpers.go#L93)
  - [backend/internal/tunnelauth/oauth.go](backend/internal/tunnelauth/oauth.go#L298)

#### Issue

When `TRUST_PROXY_HEADERS` is enabled, the app unconditionally trusts `CF-Connecting-IP`, `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. There is no verification that the immediate client is an actual trusted reverse proxy.

#### Impact

If the app is reachable by requests carrying attacker-controlled forwarding headers, an attacker can:

- spoof the client IP used by rate limiting
- influence OAuth callback URL construction
- weaken assumptions around request provenance

#### Remediation

- Only honor proxy headers when `RemoteAddr` belongs to an explicit trusted proxy CIDR or allowlist.
- Prefer a fixed configured public base URL for OAuth callback generation instead of deriving it from request headers.
- Document the deployment invariant clearly if proxy-header trust is required.

#### Resolution

Mitigated by configuration. `TRUST_PROXY_HEADERS` defaults to `false`; only enable
it when elPasto is behind a trusted reverse proxy that strips untrusted forwarding
headers before adding its own. Self-hosted deployments should prefer a fixed
`TUNNEL_BASE_URL` for OAuth callback construction rather than deriving public
URLs from client-controlled request headers.

### Medium: Server-relay capability URLs are exposed directly to the browser

- Severity: Medium
- Files:
  - [hooks/useTunnelRelay.ts](hooks/useTunnelRelay.ts#L265)
  - [hooks/useTunnelRelay.ts](hooks/useTunnelRelay.ts#L279)

#### Issue

The server returns a tunnel capability prefix, and the client opens that prefix directly in a new tab with `window.open(data.prefix, "_blank", "noopener")`.

#### Impact

The bearer capability token becomes part of the visible URL and may be persisted in browser history, synced history, screenshots, crash reports, or accidental copy/paste. The codebase already has a fragment-based viewer path intended to reduce that exposure, but this direct-open path bypasses it.

#### Remediation

- Open `/tunnel-view/{peerId}?serverRelay=1#${encodeURIComponent(prefix)}` instead of opening the raw prefix.
- Validate the fragment before assigning it to `iframe.src`.
- Consider issuing short-lived one-time viewer claims instead of long-lived raw capability URLs.

#### Resolution

Fixed. `openTunnel` now routes server-relay tunnels through `/tunnel-view/{peerId}?serverRelay=1#<encoded-prefix>` instead of opening the raw capability URL. The prefix never appears in browser history or the visible address bar.

### Low: `/api/stats` exposes live operational metadata without authorization

- Severity: Low
- Files:
  - [backend/internal/api/server.go](backend/internal/api/server.go#L185)
  - [backend/internal/api/handlers_session.go](backend/internal/api/handlers_session.go#L241)
  - [backend/internal/stats/stats.go](backend/internal/stats/stats.go#L47)

#### Issue

`/api/stats` is publicly reachable and returns live usage and connection metadata, including per-session connection aggregates keyed by hashed session token.

#### Impact

Even with hashed session identifiers, this leaks operational information that can be used for reconnaissance, traffic analysis, and correlation of active usage patterns.

#### Remediation

- Require admin authentication for `/api/stats`, or
- remove session-level connection details from the public response, and
- keep only coarse aggregate counters for unauthenticated access, if public stats are needed at all.

#### Resolution

Fixed. Removed the per-session `connections` map from the stats endpoint. `/api/stats` now returns only aggregate counters (SSE connections, active tunnels, sessions with viewers) with no session-level breakdown.

## Notes

- This was a static review only. I did not run the application or test suite.
- Findings were prioritized by exploitability and likely impact in the current architecture.
