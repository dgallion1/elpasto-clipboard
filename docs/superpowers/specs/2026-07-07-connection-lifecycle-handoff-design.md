# Connection Lifecycle & Device Handoff — Design

**Date:** 2026-07-07
**Status:** Approved, ready for implementation planning
**Scope:** Session view (`app/[token]/`) + `SessionHeader`. Frontend only — no backend, WebRTC, or signaling changes.

## Problem

elPasto's core job is moving clips *between your devices*, so the single most
important question a user has is **"is my other device connected yet?"** Today the
UI answers this poorly:

- When a user is alone in a session (`peers.length === 0`) the header renders
  **nothing** — no signal that they're waiting for a device to join. This is the
  most common first-run moment and it's blank.
- Connection status, when it exists, is buried behind a `"N direct peers"` badge
  that opens a dropdown. It is not glanceable.
- Cross-device handoff (the QR code) is a small secondary header button, under-
  prioritized relative to how central "get this session onto my other device" is.

The current connection state model (unchanged by this work):

- `readyPeerCount` — peers whose direct data channel is `"open"`.
- `peers[].channelState: RTCDataChannelState | "none"` — per-peer channel state
  (`"connecting"`, `"open"`, `"closing"`, `"closed"`, `"none"`).
- `tunnels` — relay fallback path (`TunnelBadge`).

## Goals

1. Make connection status a **persistent, glanceable** signal across the whole
   lifecycle (waiting → connecting → connected).
2. Surface **device handoff (QR + copy)** prominently at the moment it matters —
   when no device is connected — without covering content the user wants to see.

## Non-goals (YAGNI)

- No WebRTC / signaling / backend changes. State is derived from data the hooks
  already expose.
- No tunnel UX overhaul — `TunnelBadge` stays; tunnel state is merely *reflected*
  in the new connection pill.
- No header decluttering (opportunity #1) or thread native-dialog replacement
  (opportunity #2). Those are separate efforts.

## Design

### 1. Derived connection state (pure, testable)

A new pure module `lib/connection-state.ts` derives a single `ConnectionState`
from existing hook outputs. No new state is stored anywhere.

```ts
export type ConnectionState =
  | "waiting"            // peers.length === 0 and no active tunnel
  | "connecting"         // >=1 peer present, some channelState "connecting", none "open"
  | "connected-direct"   // readyPeerCount >= 1
  | "connected-tunnel";  // relay path active, no direct "open" channel

export function deriveConnectionState(input: {
  peers: PeerInfo[];
  readyPeerCount: number;
  tunnels: TunnelInfo[];
}): ConnectionState;
```

Precedence when evaluating: `connected-direct` > `connected-tunnel` > `connecting`
> `waiting`. (A direct channel always wins the label even if a tunnel also exists.)

Palette (reuses the project's existing semantic accents):

| State | Accent |
|---|---|
| `waiting` | neutral |
| `connecting` | amber (matches today's yellow connecting dot) |
| `connected-direct` | emerald |
| `connected-tunnel` | sky |

Because it's a pure function, `SessionPageView` and `SessionHeader` stay dumb and
every state is unit-testable from inputs.

### 2. Handoff surface — `components/DeviceHandoff.tsx`

One component, three presentations selected by **(state × active-thread content)**:

- **Full center panel** — `waiting` AND the active thread is empty.
  Fills the empty paste area. Contains:
  - Inline QR via `QRCodeSVG` from `qrcode.react` (already a dependency; reuse the
    same dynamic-import pattern as `QRCodeModal`).
  - Heading "Scan to link your phone".
  - `Copy URL` · `Copy token` actions.
  - A soft-pulsing "waiting for your other device…" status line.

- **Slim banner** — `waiting` AND the active thread has ≥1 clip.
  A single line rendered *above* the clip list, never covering content:
  `○ No device linked yet · Show QR · Copy URL · ✕`
  - "Show QR" opens the existing `QRCodeModal`.
  - `✕` dismisses for the current session only (persist a dismiss flag in
    `sessionStorage`, keyed by token). Reappears on next visit / new session.

- **Connecting overlay text** — when state is `connecting`, whichever surface is
  showing swaps its status line to an amber, pulsing "Device connecting…". No
  layout jump between waiting and connecting.

When state becomes `connected-direct` or `connected-tunnel`, `DeviceHandoff`
renders nothing (unmounts) — content reclaims the full area.

### 3. Header connection pill — `components/ConnectionPill.tsx`

Replace the current `peers.length > 0` `"N direct peers"` badge block in
`SessionHeader` with a pill driven by the same `ConnectionState`:

| State | Pill |
|---|---|
| `waiting` | *(nothing — the center panel / banner owns this moment)* |
| `connecting` | amber, pulsing, "Linking…" |
| `connected-direct` | emerald, `● {peerName}` if one peer; `● {n} devices` if more |
| `connected-tunnel` | sky, `● {peerName} · relay` |

Clicking the pill preserves **today's peer dropdown** (rename / ping / per-device
detail) verbatim — only the trigger's label/styling changes. Peer name comes from
`peerNames`; fall back to the existing `peerDisplayName` helper.

### 4. Transition feel

On the first transition into `connected-direct`, a brief emerald flash as the pill
appears and the panel/banner dismisses — reuse the existing 500ms background
transition and the `IdentifyFlashOverlay` idiom already in the session view. Keep
it subtle (speed-is-a-feature).

Accessibility: the connection status region uses `aria-live="polite"` and announces
transitions ("Device connected", "Device connecting"). Every status dot carries a
text label — never color alone (dark-only, WCAG AA).

## Components & file changes

**New**
- `lib/connection-state.ts` — pure `deriveConnectionState` + `ConnectionState` type.
- `components/DeviceHandoff.tsx` — center panel + slim banner + connecting text.
- `components/ConnectionPill.tsx` — header pill (wraps/triggers existing peer dropdown).

**Edit**
- `app/[token]/SessionPageView.tsx` — compute `ConnectionState`; mount
  `DeviceHandoff` in the empty-area / above-clips slot; pass session URL + token.
- `components/SessionHeader.tsx` — swap the `peers.length > 0` badge block for
  `ConnectionPill`; keep the peer dropdown behavior.

**Reuse**
- `QRCodeSVG` (`qrcode.react`) for the inline panel QR.
- `QRCodeModal` for the slim banner's "Show QR".
- Existing peer dropdown, `peerDisplayName`, `getSessionUrl`.

## Testing

- `lib/connection-state.ts`: pure unit tests covering every input combination →
  expected state, including precedence (direct over tunnel; connecting only when no
  open channel).
- `DeviceHandoff`: render tests — empty+waiting → panel; clips+waiting → banner;
  `connecting` → amber text; connected → renders nothing; ✕ dismiss writes
  `sessionStorage` and hides banner; "Show QR" opens modal.
- `ConnectionPill`: one test per state, including single-peer name vs. multi-device
  count and the `· relay` suffix.
- Update existing `SessionPageView` / `SessionHeader` tests affected by the badge →
  pill swap.

## Open questions

None. Peer-name-in-pill and per-session banner dismiss were both confirmed during
design.
