# Peer-to-Peer Networking Patterns

A reusable reference for browser-based P2P systems that use a small coordination service, WebRTC data channels, and browser-local persistence. The examples are informed by [elpasto](https://github.com/your-org/elpasto), but the patterns below are intended to transfer to other products.

This document focuses on the peer layer: signaling, connection setup, payload transfer, reconciliation, and recovery. It is not a full application architecture.

---

## Table of Contents

1. [Design Goals](#1-design-goals)
2. [Architecture Shape](#2-architecture-shape)
3. [Signaling Layer](#3-signaling-layer)
4. [Peer Mesh and Negotiation](#4-peer-mesh-and-negotiation)
5. [Data Channel Protocol](#5-data-channel-protocol)
6. [Sync, Deletion, and Recovery](#6-sync-deletion-and-recovery)
7. [Local Persistence](#7-local-persistence)
8. [Adapting the Pattern](#8-adapting-the-pattern)
9. [elpasto Mapping](#9-elpasto-mapping)

---

## 1. Design Goals

This pattern is a good fit when you want:

- A thin backend that coordinates peers without owning most payload bytes
- Direct browser-to-browser transfer for blobs, files, or encrypted payloads
- Local-first restore from IndexedDB so reconnects and reloads are cheap
- Eventual consistency between intermittently connected peers
- A clean place to add TURN credentials, tunnel announcements, or other side-band session metadata

Typical use cases:

- Device-to-device clipboard or file handoff
- Peer-discovered local tools and service tunnels
- Ephemeral session sharing without central blob storage
- Local-first apps where the server should coordinate, not store content

Less ideal use cases:

- High-frequency shared editing where CRDT/OT semantics matter more than blob transfer
- Workloads that require strict global ordering or authoritative conflict resolution
- Environments where WebRTC is unavailable or heavily blocked

---

## 2. Architecture Shape

The reusable shape is:

1. A coordination service creates or validates a session.
2. Browsers open a long-lived event stream for peer discovery.
3. Browsers POST signaling messages through the service.
4. Peers establish WebRTC connections and exchange application data over named data channels.
5. Each browser persists enough metadata and payload state locally to survive reloads and reconnects.

```
                    +-------------------------------+
                    |   Coordination Service        |
                    |   session metadata            |
                    |   SSE event stream            |
                    |   POST signal relay           |
                    |   optional TURN credentials   |
                    |   optional side-band events   |
                    +---------------+---------------+
                                    |
                         SSE + POST |
                                    |
              +---------------------+---------------------+
              |                     |                     |
        +-----+------+       +------+-----+       +------+-----+
        | Browser A  |       | Browser B  |       | Browser C  |
        | IndexedDB  |       | IndexedDB  |       | IndexedDB  |
        +-----+------+       +------+-----+       +------+-----+
              |                     |                     |
              +---------- WebRTC data channels ----------+
```

Important boundary:

- The coordination service does not need to be fully stateless.
- It can store session metadata, issue TURN credentials, track live subscriptions, or publish non-P2P events.
- What matters is that the peer transport and payload sync stay decoupled from that server state.

In elPasto specifically, this distinction matters because the same session bootstrap can also surface TURN credentials and tunnel announcements in addition to peer signaling.

---

## 3. Signaling Layer

### Session Bootstrap

At minimum, peers need:

- A session identifier or token
- Expiry or validity metadata
- A signaling endpoint

Common optional additions:

- TURN credentials
- Existing tunnel metadata
- Feature flags
- Server capability hints

Generic bootstrap shape:

```json
{
  "token": "session-token",
  "expiresAt": "2026-03-28T18:30:00Z",
  "turnCredentials": {
    "urls": ["turn:turn.example.com:3478?transport=udp"],
    "username": "ephemeral-user",
    "credential": "ephemeral-secret"
  }
}
```

### SSE + POST Relay

A simple and durable signaling design is:

- `GET /sessions/{token}/events` for server-to-client events via SSE
- `POST /sessions/{token}/signal` for client-to-server signal submission

Why this works well:

- `EventSource` reconnects automatically
- SSE tolerates many proxy setups well
- The server does not need a full duplex peer socket per browser
- The signaling message format stays opaque to the relay

Typical SSE events:

- `peer:signal`
- `session:expired`
- optional product-specific events such as `tunnel:announce` or `tunnel:close`

### Broker Pattern

The server-side broker can be nothing more than a session-scoped pub/sub hub:

```go
type Broker struct {
    mu   sync.RWMutex
    subs map[string]map[chan Event]string
}

type Event struct {
    Name string
    Data any
}
```

Useful implementation details:

- Use buffered channels so ICE bursts do not stall publishers
- Make unsubscribe idempotent with `sync.Once`
- Snapshot subscribers under a read lock, then publish outside the lock
- Drop events for slow consumers rather than blocking the session
- Clean up empty session entries to avoid unbounded growth

### Validation and Limits

The relay should validate envelope shape, not business meaning.

Typical checks:

- `fromPeerId` must be a non-empty string
- `signalType` must be a non-empty string
- `toPeerId`, when present, must be a non-empty string
- Request size must be bounded
- Per-IP or per-session rate limits should exist

The exact thresholds are product-specific. In elPasto today, the signaling path uses:

- 10 concurrent SSE connections per IP
- 240 signal POSTs per minute per IP
- 256 KiB max signal body
- 25 second SSE keepalive pings

Those are examples, not required values.

---

## 4. Peer Mesh and Negotiation

### Peer Identity and Discovery

Each browser instance should generate its own peer ID when it joins a session. A random UUID is enough for most apps.

A durable discovery pattern is:

1. Peer A connects to SSE.
2. Peer A broadcasts `announce`.
3. Peer B receives it, creates local peer state, and sends a targeted `announce` back.
4. Both sides now have enough information to negotiate.

This two-way announce avoids timing holes where one peer subscribed after another peer already announced.

### Perfect Negotiation

Use deterministic role assignment so both peers independently compute the same answer.

Example:

```ts
const polite = localPeerId.localeCompare(remotePeerId) > 0;
```

Then:

- The polite peer rolls back during offer collisions
- The other peer ignores colliding offers
- No separate coordinator message is needed

This keeps the mesh stable as peers reconnect, reload, or re-announce.

### Creating the Initial Data Channel

One peer should be responsible for creating the primary data channel. A common rule is:

- The peer with the lexicographically smaller ID creates the initial `"clips"` channel

That gives you one deterministic creator without another handshake.

### Recovery Behavior

A production peer mesh needs explicit cleanup and retry rules.

Recommended triggers:

- Connection setup timeout
- `connectionstatechange` to `failed`, `closed`, or `disconnected`
- Data channel close
- Explicit `leave` signal on unmount

The recovery action is usually:

1. Tear down peer-local state
2. Release pending ownership or timeouts
3. Re-announce after a short debounce

In elPasto, the current connection timeout is 10 seconds and re-announce is debounced by 1 second.

### TURN and NAT Traversal

The WebRTC constructor should accept optional TURN credentials from session bootstrap:

```ts
const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

if (turnCredentials) {
  iceServers.push({
    urls: turnCredentials.urls,
    username: turnCredentials.username,
    credential: turnCredentials.credential,
  });
}

return new RTCPeerConnection({ iceServers });
```

This keeps peer setup generic:

- STUN-only when relay is unnecessary
- TURN-enabled when the deployment needs fallback connectivity

---

## 5. Data Channel Protocol

### Named Channels

Use channel labels to separate traffic classes.

A strong default is:

- `"clips"` for control messages and bulk payload transfer
- `"tunnel"` or another dedicated label for a second subsystem

That avoids inventing a multiplexing layer too early.

### Control vs Binary Frames

WebRTC already gives you message type discrimination:

```ts
if (typeof data === "string") {
  const message = JSON.parse(data);
} else {
  const chunk = parseChunkFrame(data);
}
```

This is enough for many applications.

### Control Message Families

The exact schema is app-specific, but these families recur:

- Transfer lifecycle: `clip:start`, `clip:end`
- Mutation propagation: `clip:update`, `clip:delete`, `clips:clear`
- Catalog sync: `catalog:offer`, `catalog:request`, `catalog:unavailable`
- Peer metadata: `peer:name`, `peer:names-sync`, `peer:identify`
- Namespace sync: `threads:sync`, `thread:created`, `thread:renamed`, `thread:deleted`, `thread:reordered`

If you adapt this pattern to another domain, replace `clip:*` and `catalog:*` with your own nouns. The transport shape still holds.

### Chunk Framing

For blob transfer, a compact frame format works well:

```
+-------------------+-----------------------------+-------------------+
| 4 bytes           | N bytes                     | remaining bytes   |
| header length     | JSON header                 | payload           |
| uint32 BE         | {"type":"chunk",...}        | raw bytes         |
+-------------------+-----------------------------+-------------------+
```

This gives you:

- Ordered chunk assembly
- Transfer ID + chunk index in the header
- One binary send per chunk

In elPasto today:

- chunk size is 16 KiB
- the first 4 bytes store header length
- the JSON header includes `transferId` and `index`

### Backpressure

The sender must respect `bufferedAmount`.

Typical pattern:

```ts
const HIGH_WATERMARK = 256 * 1024;
const LOW_WATERMARK = 64 * 1024;
```

When `bufferedAmount` exceeds the high watermark:

1. Set `bufferedAmountLowThreshold`
2. Wait for `bufferedamountlow`
3. Abort if the channel closes or errors

### Sliding Transfer Timeout

A transfer timeout should usually be a sliding window, not a fixed stopwatch.

That means:

- Start a timeout at `clip:start`
- Reset it on each chunk append
- Fail the transfer only if the stream goes quiet for too long

In elPasto today, that window is 20 seconds.

---

## 6. Sync, Deletion, and Recovery

### Catalog-Based Reconciliation

When a data channel opens, both peers exchange metadata-only catalogs and request what they are missing.

This is one of the most portable patterns in the design because it decouples:

- discovery of available content
- transfer of actual content
- restore from local persistence

The receiver-side decision is:

1. Do I already know this transfer?
2. Do I already have the payload bytes?
3. Is it tombstoned?
4. Is someone else already responsible for fetching it?

Only then send `catalog:request`.

### Restore Barrier

Do not send or process catalog offers until the initial local restore has completed.

Without that barrier:

- peers request data they already have in IndexedDB
- deleted items can be re-offered before tombstones load
- sender and receiver state can race each other during startup

This barrier is an implementation detail worth preserving in other apps.

### Transfer Ownership

If several peers can serve the same payload, only one peer should own the active fetch.

Simple pattern:

```ts
const transferOwners = new Map<string, string>(); // transferId -> peerId
```

Rules:

- reserve on `catalog:request`
- accept the same owner on `clip:start`
- release on completion, failure, delete, or timeout
- retry another peer on `catalog:unavailable`

This prevents duplicate transfers and keeps failure recovery simple.

### Tombstone-Based Deletion

Deletes need durable memory. Otherwise a stale peer will resurrect removed content during a later catalog exchange.

Use tombstones:

```ts
interface TombstoneRecord {
  transferId: string;
  sessionToken: string;
  deletedAt: number;
}
```

Core rules:

- Record a tombstone when the local user deletes content
- Record a tombstone when a peer delete is received
- Exclude tombstoned items from future catalog offers
- Reject tombstoned incoming offers and clean up any local remnants
- Propagate tombstones to late-joining peers: when a catalog offer contains tombstoned clips, send `clip:delete` back so the offering peer cleans up
- Prune tombstones with a bounded policy

In elPasto today, tombstones are capped at 500 per session.

---

## 7. Local Persistence

### IndexedDB Store Shape

A practical schema is:

- one object store for persisted transfer records
- one object store for tombstones
- session-scoped queries via an index

For transfer records, keep enough information to:

- rebuild the catalog entry
- restore sender-owned files
- restore receiver-owned ciphertext or payload bytes
- preserve encryption metadata if needed

### Tab-Scoped Keys

If multiple tabs can join the same session, use a composite storage key such as:

```text
{ownerTabId}:{transferId}
```

This prevents two live tabs from overwriting each other's sender or receiver state.

The `ownerTabId` can come from `sessionStorage`, with rotation on duplicated-tab navigation.

### Migration and Orphan Adoption

Two persistence problems show up quickly in real apps:

1. IndexedDB key layout changes over time
2. A full browser restart clears `sessionStorage`, so a new tab ID no longer matches old records

Useful patterns:

- Read-all, recreate-store, reinsert for keyPath migrations
- Adopt orphaned records into the current tab ID if no records match the current owner, but exclude and delete any records whose `transferId` is already tombstoned for the session

These details are not glamorous, but they are what make local-first recovery actually reliable.

### Memory Fallback

If IndexedDB is unavailable, keep the same API surface and fall back to in-memory maps.

You lose reload persistence, but:

- tests stay simple
- SSR and restricted browser contexts keep working
- the rest of the sync logic does not need special branches everywhere

---

## 8. Adapting the Pattern

To use this concept for other products, keep the structure and swap the domain model.

What usually stays the same:

- SSE + POST signaling
- deterministic perfect negotiation
- one or more named data channels
- metadata-first catalog exchange
- transfer ownership
- tombstones
- IndexedDB persistence with tab scoping

What usually changes:

- the catalog entry schema
- the transfer envelope schema
- whether payloads are encrypted before send
- whether a second channel is needed for another subsystem
- the timeout, chunk size, and backpressure thresholds

Examples:

- File drop app: keep almost everything as-is, rename `clip:*` to `file:*`
- Multi-device cache warmer: catalog entries become artifact manifests and versions
- Peer-discovered tool bridge: keep signaling and mesh setup, replace the bulk-transfer protocol with request/response messages
- Local service exposure: reuse peer discovery and the optional second data channel for tunnel traffic

One caution:

- If your other use case needs collaborative editing rather than transfer and reconciliation, use this as the connection substrate, not as the sync model itself.

---

## 9. elpasto Mapping

The current elPasto implementation maps these ideas to the following files:

| Concern | File |
|---------|------|
| SSE broker | `backend/internal/events/broker.go` |
| SSE handlers and signal relay | `backend/internal/api/handlers_events.go` |
| Session bootstrap and TURN credentials | `backend/internal/api/handlers_session.go` |
| Peer-signal type | `lib/realtime-session.ts` |
| WebRTC helpers and direct-transfer send path | `lib/webrtc.ts` |
| Chunk framing and transfer store | `lib/direct-transfer.ts` |
| Peer mesh, negotiation, catalogs, tombstones | `hooks/usePeerMesh.ts` |
| SSE client and side-band tunnel events | `hooks/useRealtimeSession.ts` |
| IndexedDB clip and tombstone persistence | `lib/clip-store.ts` |
| Optional tunnel relay on top of peer channels | `hooks/useTunnelRelay.ts` |

Two elPasto-specific notes that are useful when generalizing:

- The `"tunnel"` data channel is optional and independent from the main `"clips"` channel.
- Server-relay tunnel discovery is not part of `peer:signal`; it arrives as dedicated SSE events (`tunnel:announce` and `tunnel:close`).

That separation is worth preserving in other apps too: keep peer negotiation, side-band session events, and application payload transport as distinct layers.
