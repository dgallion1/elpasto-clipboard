# Security policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's private vulnerability
reporting:

1. Go to the Security tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the form. GitHub will route the report directly to the maintainers.

Do **not** open public GitHub issues for security vulnerabilities.

Expect an acknowledgement within 7 days. Practical fixes are merged to `main`
and called out in release notes.

## Scope

In scope:

- Authentication and session-token handling in the Go backend (`backend/`).
- WebRTC signaling and tunnel-auth flows.
- Cryptographic clip protection (AES-GCM normal mode, HKDF-SHA256 paranoid mode).
- Rate limiting and capability-URL handling.
- Anything that lets an unauthenticated user enumerate sessions, read another
  user's clip data, or escalate the rate limits.

Out of scope:

- Vulnerabilities in third-party dependencies — please report upstream first.
  If exploitable through elpasto's surface, also let us know so we can pin the
  upgrade.
- Issues that require physical access to a victim's device.
- Self-hosted misconfiguration (no `TURN_SECRET` rotation, exposed admin
  endpoints, weak reverse-proxy TLS, etc.).
- Social-engineering attacks that don't involve a software flaw.

## Supported versions

The `main` branch is the only actively maintained version.
