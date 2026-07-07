# Connection Lifecycle & Device Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give elPasto a glanceable, lifecycle-aware connection indicator plus a prominent device-handoff surface (inline QR panel → slim banner) so a user always knows whether their other device is connected.

**Architecture:** A single pure function derives one `ConnectionState` from data the mesh/tunnel hooks already expose. `SessionPageView` computes it once and drives two presentational components: `DeviceHandoff` (center QR panel when the thread is empty, slim banner once it has clips) and `ConnectionPill` (header status pill that reuses the existing peer dropdown). No backend, WebRTC, or signaling changes.

**Tech Stack:** Next.js 15 (App Router), TypeScript (strict), Tailwind CSS v4, `qrcode.react` (already a dependency), Vitest + `@testing-library/react` + jsdom.

## Global Constraints

- No new dependencies. QR uses the existing `qrcode.react` (`QRCodeSVG`, dynamically imported).
- No backend / WebRTC / signaling changes — state is derived purely from existing hook outputs (`peers`, `readyPeerCount`, `tunnels`).
- Dark-only, base `neutral-950`. Semantic accents only: emerald = active/connected, blue = primary, red = danger, amber = warning/connecting, sky = tunnel/relay.
- Accessibility: WCAG AA. Status dots must carry a text label — never color alone. Connection-status regions use `role="status"` + `aria-live="polite"`.
- TypeScript strict. System fonts; monospace only for tokens/IDs.
- Tests: every `*.test.tsx` starts with `// @vitest-environment jsdom`; use `render`/`cleanup` from `@testing-library/react`, `afterEach(cleanup)`.
- Run a single test file with `pnpm vitest run <path>`. Type-check with `pnpm tsc --noEmit`. Pre-commit hook runs `make check` (type-check + lint + vitest + full Go pipeline).

---

### Task 1: `deriveConnectionState` pure function

**Files:**
- Create: `lib/connection-state.ts`
- Test: `lib/connection-state.test.ts`

**Interfaces:**
- Consumes: `PeerInfo` from `@/hooks/usePeerMesh` (`{ peerId: string; channelState: RTCDataChannelState | "none"; hasTunnel: boolean; name?: string }`), `TunnelInfo` from `@/hooks/useTunnelRelay` (`{ peerId: string; label?: string; port?: number; serverRelay?: boolean; prefix?: string }`).
- Produces: `type ConnectionState = "waiting" | "connecting" | "connected-direct" | "connected-tunnel"` and `function deriveConnectionState(input: { peers: PeerInfo[]; readyPeerCount: number; tunnels: TunnelInfo[] }): ConnectionState`.

- [ ] **Step 1: Write the failing test**

`lib/connection-state.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { deriveConnectionState } from "./connection-state";
import type { PeerInfo } from "@/hooks/usePeerMesh";

const peer = (channelState: PeerInfo["channelState"]): PeerInfo => ({
  peerId: "p1",
  channelState,
  hasTunnel: false,
});

describe("deriveConnectionState", () => {
  test("no peers and no tunnels → waiting", () => {
    expect(deriveConnectionState({ peers: [], readyPeerCount: 0, tunnels: [] })).toBe("waiting");
  });

  test("a peer present but none open → connecting", () => {
    expect(
      deriveConnectionState({ peers: [peer("connecting")], readyPeerCount: 0, tunnels: [] })
    ).toBe("connecting");
    expect(
      deriveConnectionState({ peers: [peer("none")], readyPeerCount: 0, tunnels: [] })
    ).toBe("connecting");
  });

  test("an open channel → connected-direct (wins over tunnel)", () => {
    expect(
      deriveConnectionState({
        peers: [peer("open")],
        readyPeerCount: 1,
        tunnels: [{ peerId: "p1" }],
      })
    ).toBe("connected-direct");
  });

  test("tunnel active, no open direct channel → connected-tunnel", () => {
    expect(
      deriveConnectionState({ peers: [], readyPeerCount: 0, tunnels: [{ peerId: "p1" }] })
    ).toBe("connected-tunnel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/connection-state.test.ts`
Expected: FAIL — cannot resolve `./connection-state`.

- [ ] **Step 3: Write minimal implementation**

`lib/connection-state.ts`:
```ts
import type { PeerInfo } from "@/hooks/usePeerMesh";
import type { TunnelInfo } from "@/hooks/useTunnelRelay";

export type ConnectionState =
  | "waiting"
  | "connecting"
  | "connected-direct"
  | "connected-tunnel";

/**
 * Derive a single connection state from mesh + tunnel data the hooks already
 * expose. Precedence: an open direct channel always wins; then an active
 * tunnel; then any present-but-not-open peer counts as "connecting"; otherwise
 * we are alone and "waiting".
 */
export function deriveConnectionState(input: {
  peers: PeerInfo[];
  readyPeerCount: number;
  tunnels: TunnelInfo[];
}): ConnectionState {
  const { peers, readyPeerCount, tunnels } = input;
  if (readyPeerCount > 0) return "connected-direct";
  if (tunnels.length > 0) return "connected-tunnel";
  if (peers.length > 0) return "connecting";
  return "waiting";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/connection-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/connection-state.ts lib/connection-state.test.ts
git commit -m "feat: derive ConnectionState from mesh + tunnel data"
```

---

### Task 2: Extract `getSessionUrl` helper

**Files:**
- Create: `lib/session-url.ts`
- Test: `lib/session-url.test.ts`
- Modify: `components/SessionHeader.tsx:221-227` (replace the inline `getSessionUrl` body with a call to the helper)

**Interfaces:**
- Produces: `function getSessionUrl(token: string): string` — returns the absolute session URL for the current origin with pathname `/{token}` and no query/hash.

- [ ] **Step 1: Write the failing test**

`lib/session-url.test.ts`:
```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { getSessionUrl } from "./session-url";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSessionUrl", () => {
  test("builds an absolute URL for the token with no query or hash", () => {
    vi.stubGlobal("window", {
      location: { href: "https://elpasto.app/old-token?x=1#frag" },
    } as unknown as Window);
    expect(getSessionUrl("elk-piano-river")).toBe("https://elpasto.app/elk-piano-river");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/session-url.test.ts`
Expected: FAIL — cannot resolve `./session-url`.

- [ ] **Step 3: Write minimal implementation**

`lib/session-url.ts`:
```ts
/** Absolute URL for a session token on the current origin, stripped of query and hash. */
export function getSessionUrl(token: string): string {
  const url = new URL(window.location.href);
  url.pathname = `/${token}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/#$/, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/session-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `SessionHeader` to use the helper**

In `components/SessionHeader.tsx`, add to the imports near the other `@/lib` imports:
```ts
import { getSessionUrl as buildSessionUrl } from "@/lib/session-url";
```
Replace the existing `getSessionUrl` callback (currently at lines 221-227):
```ts
  const getSessionUrl = useCallback(() => {
    const url = new URL(window.location.href);
    url.pathname = `/${token}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/#$/, "");
  }, [token]);
```
with:
```ts
  const getSessionUrl = useCallback(() => buildSessionUrl(token), [token]);
```

- [ ] **Step 6: Verify nothing broke**

Run: `pnpm vitest run components/SessionHeader.test.tsx` and `pnpm tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 7: Commit**

```bash
git add lib/session-url.ts lib/session-url.test.ts components/SessionHeader.tsx
git commit -m "refactor: extract getSessionUrl into lib/session-url"
```

---

### Task 3: `ConnectionPill` header component

**Files:**
- Create: `components/ConnectionPill.tsx`
- Test: `components/ConnectionPill.test.tsx`

**Interfaces:**
- Consumes: `ConnectionState` from `@/lib/connection-state`; `PeerInfo` from `@/hooks/usePeerMesh`.
- Produces: `function ConnectionPill(props: { state: ConnectionState; peers: PeerInfo[]; peerNames: Record<string, string>; pulse?: boolean; onClick: () => void }): JSX.Element | null` — renders `null` when `state === "waiting"`, otherwise a status button.

- [ ] **Step 1: Write the failing test**

`components/ConnectionPill.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConnectionPill } from "./ConnectionPill";
import type { PeerInfo } from "@/hooks/usePeerMesh";

const peer = (peerId: string): PeerInfo => ({ peerId, channelState: "open", hasTunnel: false });

afterEach(() => cleanup());

describe("ConnectionPill", () => {
  test("renders nothing while waiting", () => {
    const view = render(
      <ConnectionPill state="waiting" peers={[]} peerNames={{}} onClick={() => undefined} />
    );
    expect(view.container.firstChild).toBeNull();
  });

  test("shows Linking… while connecting", () => {
    const view = render(
      <ConnectionPill state="connecting" peers={[peer("p1")]} peerNames={{}} onClick={() => undefined} />
    );
    expect(view.getByText("Linking…")).toBeTruthy();
  });

  test("shows the peer name when one device is connected", () => {
    const view = render(
      <ConnectionPill
        state="connected-direct"
        peers={[peer("p1")]}
        peerNames={{ p1: "Laptop" }}
        onClick={() => undefined}
      />
    );
    expect(view.getByText("Laptop")).toBeTruthy();
  });

  test("shows a device count when multiple are connected", () => {
    const view = render(
      <ConnectionPill
        state="connected-direct"
        peers={[peer("p1"), peer("p2")]}
        peerNames={{}}
        onClick={() => undefined}
      />
    );
    expect(view.getByText("2 devices")).toBeTruthy();
  });

  test("appends · relay for tunnel connections and fires onClick", () => {
    const onClick = vi.fn();
    const view = render(
      <ConnectionPill
        state="connected-tunnel"
        peers={[peer("p1")]}
        peerNames={{ p1: "Laptop" }}
        onClick={onClick}
      />
    );
    expect(view.getByText("Laptop · relay")).toBeTruthy();
    fireEvent.click(view.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/ConnectionPill.test.tsx`
Expected: FAIL — cannot resolve `./ConnectionPill`.

- [ ] **Step 3: Write minimal implementation**

`components/ConnectionPill.tsx`:
```tsx
"use client";

import type { PeerInfo } from "@/hooks/usePeerMesh";
import type { ConnectionState } from "@/lib/connection-state";

interface ConnectionPillProps {
  state: ConnectionState;
  peers: PeerInfo[];
  peerNames: Record<string, string>;
  /** One-shot emerald ring when a connection is freshly established. */
  pulse?: boolean;
  onClick: () => void;
}

function connectedLabel(peers: PeerInfo[], peerNames: Record<string, string>): string {
  if (peers.length === 0) return "device";
  if (peers.length === 1) {
    const p = peers[0];
    return peerNames[p.peerId] ?? p.name ?? p.peerId.slice(0, 8);
  }
  return `${peers.length} devices`;
}

export function ConnectionPill({ state, peers, peerNames, pulse, onClick }: ConnectionPillProps) {
  if (state === "waiting") return null;

  if (state === "connecting") {
    return (
      <button
        onClick={onClick}
        aria-label="Connection status: linking to a device"
        className="flex items-center gap-1.5 rounded-full border border-amber-900 bg-amber-950/50 px-2 py-0.5 text-xs text-amber-300 transition-colors hover:bg-amber-900/40 cursor-pointer"
      >
        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        Linking…
      </button>
    );
  }

  const isTunnel = state === "connected-tunnel";
  const label = connectedLabel(peers, peerNames);
  const ring = pulse ? "ring-2 ring-emerald-400/60" : "";
  return (
    <button
      onClick={onClick}
      aria-label={`Connection status: connected to ${label}${isTunnel ? " via relay" : ""}`}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-all cursor-pointer ${ring} ${
        isTunnel
          ? "border-sky-900 bg-sky-950/50 text-sky-300 hover:bg-sky-900/40"
          : "border-emerald-900 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/40"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${isTunnel ? "bg-sky-400" : "bg-emerald-400"}`} />
      {isTunnel ? `${label} · relay` : label}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/ConnectionPill.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add components/ConnectionPill.tsx components/ConnectionPill.test.tsx
git commit -m "feat: add ConnectionPill status component"
```

---

### Task 4: `QRCode` inline component

**Files:**
- Create: `components/QRCode.tsx`
- Test: `components/QRCode.test.tsx`

**Interfaces:**
- Produces: `function QRCode(props: { value: string; size?: number }): JSX.Element` — a loading placeholder (`aria-label="Loading QR code"`) until `qrcode.react` loads, then an `<svg>` QR. `size` defaults to `176`.

- [ ] **Step 1: Write the failing test**

`components/QRCode.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QRCode } from "./QRCode";

afterEach(() => cleanup());

describe("QRCode", () => {
  test("shows a loading placeholder then renders an svg", async () => {
    const view = render(<QRCode value="https://elpasto.app/elk-piano-river" />);
    expect(view.getByLabelText("Loading QR code")).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector("svg")).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/QRCode.test.tsx`
Expected: FAIL — cannot resolve `./QRCode`.

- [ ] **Step 3: Write minimal implementation**

`components/QRCode.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";

interface QRCodeProps {
  value: string;
  size?: number;
}

type QRCodeSVGComponent = React.ComponentType<{
  value: string;
  size: number;
  level: "L" | "M" | "Q" | "H";
  includeMargin: boolean;
  bgColor: string;
  fgColor: string;
}>;

export function QRCode({ value, size = 176 }: QRCodeProps) {
  const [QRCodeSVG, setQRCodeSVG] = useState<null | QRCodeSVGComponent>(null);

  useEffect(() => {
    let cancelled = false;
    void import("qrcode.react").then((module) => {
      if (!cancelled) setQRCodeSVG(() => module.QRCodeSVG);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!QRCodeSVG) {
    return (
      <div
        aria-label="Loading QR code"
        className="rounded bg-neutral-900"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <QRCodeSVG value={value} size={size} level="M" includeMargin={true} bgColor="#0a0a0a" fgColor="#e5e5e5" />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/QRCode.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/QRCode.tsx components/QRCode.test.tsx
git commit -m "feat: add reusable inline QRCode component"
```

---

### Task 5: `DeviceHandoff` surface

**Files:**
- Create: `components/DeviceHandoff.tsx`
- Test: `components/DeviceHandoff.test.tsx`

**Interfaces:**
- Consumes: `ConnectionState` from `@/lib/connection-state`; `QRCode` from `./QRCode`; `QRCodeModal` from `./QRCodeModal`.
- Produces: `function DeviceHandoff(props: { state: ConnectionState; sessionUrl: string; token: string; hasClips: boolean }): JSX.Element | null`. Renders `null` when connected; a center panel when `!hasClips`; a slim, per-session-dismissable banner when `hasClips`.

- [ ] **Step 1: Write the failing test**

`components/DeviceHandoff.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DeviceHandoff } from "./DeviceHandoff";

afterEach(() => cleanup());
beforeEach(() => sessionStorage.clear());

const url = "https://elpasto.app/elk-piano-river";

describe("DeviceHandoff", () => {
  test("renders the center panel when empty and waiting", () => {
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={false} />
    );
    expect(view.getByText("Scan to link your phone")).toBeTruthy();
    expect(view.getByText("Waiting for your other device…")).toBeTruthy();
  });

  test("swaps to connecting copy in the panel", () => {
    const view = render(
      <DeviceHandoff state="connecting" sessionUrl={url} token="elk-piano-river" hasClips={false} />
    );
    expect(view.getByText("Device connecting…")).toBeTruthy();
  });

  test("renders the slim banner when clips exist", () => {
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={true} />
    );
    expect(view.getByText("No device linked yet")).toBeTruthy();
    expect(view.queryByText("Scan to link your phone")).toBeNull();
  });

  test("dismissing the banner hides it and persists to sessionStorage", () => {
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={true} />
    );
    fireEvent.click(view.getByLabelText("Dismiss"));
    expect(view.queryByText("No device linked yet")).toBeNull();
    expect(sessionStorage.getItem("elpasto:handoff-dismissed:elk-piano-river")).toBe("1");
  });

  test("renders nothing once connected", () => {
    const view = render(
      <DeviceHandoff state="connected-direct" sessionUrl={url} token="elk-piano-river" hasClips={false} />
    );
    expect(view.container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/DeviceHandoff.test.tsx`
Expected: FAIL — cannot resolve `./DeviceHandoff`.

- [ ] **Step 3: Write minimal implementation**

`components/DeviceHandoff.tsx`:
```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { QRCode } from "./QRCode";
import { QRCodeModal } from "./QRCodeModal";
import type { ConnectionState } from "@/lib/connection-state";

interface DeviceHandoffProps {
  state: ConnectionState;
  sessionUrl: string;
  token: string;
  hasClips: boolean;
}

const dismissKey = (token: string) => `elpasto:handoff-dismissed:${token}`;

export function DeviceHandoff({ state, sessionUrl, token, hasClips }: DeviceHandoffProps) {
  const [dismissed, setDismissed] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(dismissKey(token)) === "1");
    } catch {
      setDismissed(false);
    }
  }, [token]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem(dismissKey(token), "1");
    } catch {
      // ignore — non-fatal
    }
  }, [token]);

  const copy = useCallback(
    async (kind: "url" | "token") => {
      try {
        await navigator.clipboard.writeText(kind === "url" ? sessionUrl : token);
        setCopied(kind);
        setTimeout(() => setCopied(null), 2000);
      } catch {
        // ignore
      }
    },
    [sessionUrl, token]
  );

  if (state === "connected-direct" || state === "connected-tunnel") {
    return null;
  }

  const connecting = state === "connecting";
  const statusText = connecting ? "Device connecting…" : "Waiting for your other device…";
  const dotClass = connecting ? "bg-amber-400 animate-pulse" : "bg-neutral-500 animate-pulse";

  // Slim banner once the thread has content — never covers clips.
  if (hasClips) {
    if (dismissed) return null;
    return (
      <>
        <div
          className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/70 px-3 py-1.5 text-sm text-neutral-400"
          role="status"
          aria-live="polite"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
          <span className="min-w-0 flex-1 truncate">
            {connecting ? statusText : "No device linked yet"}
          </span>
          <button
            onClick={() => setQrOpen(true)}
            className="shrink-0 text-neutral-300 transition-colors hover:text-emerald-300"
          >
            Show QR
          </button>
          <button
            onClick={() => copy("url")}
            className="shrink-0 text-neutral-300 transition-colors hover:text-emerald-300"
          >
            {copied === "url" ? "Copied!" : "Copy URL"}
          </button>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 text-neutral-500 transition-colors hover:text-neutral-300"
          >
            ✕
          </button>
        </div>
        <QRCodeModal open={qrOpen} onClose={() => setQrOpen(false)} url={qrOpen ? sessionUrl : ""} />
      </>
    );
  }

  // Full center panel when the thread is empty.
  return (
    <div
      className="flex flex-col items-center justify-center gap-5 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <QRCode value={sessionUrl} size={192} />
      </div>
      <div className="space-y-1">
        <p className="text-lg font-medium text-neutral-200">Scan to link your phone</p>
        <p className="flex items-center justify-center gap-2 text-sm text-neutral-500">
          <span className={`h-2 w-2 rounded-full ${dotClass}`} />
          {statusText}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => copy("url")}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          {copied === "url" ? "Copied!" : "Copy URL"}
        </button>
        <button
          onClick={() => copy("token")}
          className="rounded-md px-4 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          {copied === "token" ? "Copied!" : "Copy token"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/DeviceHandoff.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add components/DeviceHandoff.tsx components/DeviceHandoff.test.tsx
git commit -m "feat: add DeviceHandoff panel + banner surface"
```

---

### Task 6: Wire `DeviceHandoff` + connection state into `SessionPageView`

**Files:**
- Modify: `app/[token]/SessionPageView.tsx`
- Test: `app/[token]/SessionPageView.test.tsx` (add cases)

**Interfaces:**
- Consumes: `deriveConnectionState`, `getSessionUrl`, `DeviceHandoff`. `SessionPageView` already receives `peers`, `readyPeerCount`, `tunnels`, `token`, `zones`, `activeZone`.
- Produces: passes new props `connectionState: ConnectionState` and `connectionPulse: boolean` down to `SessionHeader` (consumed in Task 7).

- [ ] **Step 1: Write the failing test**

Add to `app/[token]/SessionPageView.test.tsx` (reuse the file's existing render helper / default props; the snippet below assumes a `renderView(overrides)` helper — if the file instead builds props inline, mirror that style):
```tsx
test("shows the handoff panel when alone with an empty thread", () => {
  const view = renderView({
    peers: [],
    readyPeerCount: 0,
    tunnels: [],
    zones: [{ zone: "A", threadName: "A", clips: [], onClearZone: async () => {} }],
  });
  expect(view.getByText("Scan to link your phone")).toBeTruthy();
});

test("hides the handoff panel once a peer is connected", () => {
  const view = renderView({
    peers: [{ peerId: "p1", channelState: "open", hasTunnel: false }],
    readyPeerCount: 1,
    tunnels: [],
    zones: [{ zone: "A", threadName: "A", clips: [], onClearZone: async () => {} }],
  });
  expect(view.queryByText("Scan to link your phone")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run app/[token]/SessionPageView.test.tsx`
Expected: FAIL — "Scan to link your phone" not found (panel not wired yet).

- [ ] **Step 3: Implement the wiring**

In `app/[token]/SessionPageView.tsx`:

Add imports near the top:
```ts
import { DeviceHandoff } from "@/components/DeviceHandoff";
import { deriveConnectionState, type ConnectionState } from "@/lib/connection-state";
import { getSessionUrl } from "@/lib/session-url";
```

After `const activeZone = activeThreadId ?? zones[0]?.zone ?? null;` (around line 150) add derived state + the first-connect pulse:
```ts
  const connectionState = deriveConnectionState({ peers, readyPeerCount, tunnels });
  const [connectionPulse, setConnectionPulse] = useState(false);
  const prevConnectedRef = useRef(false);
  const isConnected =
    connectionState === "connected-direct" || connectionState === "connected-tunnel";
  useEffect(() => {
    if (isConnected && !prevConnectedRef.current) {
      setConnectionPulse(true);
      const id = setTimeout(() => setConnectionPulse(false), 600);
      prevConnectedRef.current = true;
      return () => clearTimeout(id);
    }
    if (!isConnected) prevConnectedRef.current = false;
  }, [isConnected]);
```
Add `useRef` to the existing React import at the top of the file:
```ts
import { useCallback, useEffect, useRef, useState } from "react";
```

In the active-thread render area, mount `DeviceHandoff` at the top of the zones container. Change the container block (currently starting near line 399):
```tsx
      <div className="flex flex-1 min-h-0 p-2 flex-col gap-2 pb-14 md:pb-2">
        {zones.map(({ zone, threadName, clips, onClearZone }) => (
```
to:
```tsx
      <div className="flex flex-1 min-h-0 p-2 flex-col gap-2 pb-14 md:pb-2">
        <DeviceHandoff
          state={connectionState}
          sessionUrl={getSessionUrl(token)}
          token={token}
          hasClips={(activeZoneModel?.clips.length ?? 0) > 0}
        />
        {zones.map(({ zone, threadName, clips, onClearZone }) => (
```

Pass the two new props to `SessionHeader` (add inside the existing `<SessionHeader ... />`, e.g. right after `token={session.token}`):
```tsx
        connectionState={connectionState}
        connectionPulse={connectionPulse}
```

Add a visually-hidden live region for screen-reader announcement. Immediately after the opening `<div className={\`flex flex-col h-screen ...\`}>` (line 300) add:
```tsx
      <span className="sr-only" role="status" aria-live="polite">
        {connectionState === "connected-direct"
          ? "Device connected"
          : connectionState === "connected-tunnel"
            ? "Device connected via relay"
            : connectionState === "connecting"
              ? "Device connecting"
              : ""}
      </span>
```
> Note: the `sr-only` utility is standard Tailwind. If the project's Tailwind v4 build does not include it, add the equivalent inline style `className="absolute h-px w-px overflow-hidden [clip:rect(0,0,0,0)]"` instead.

- [ ] **Step 4: Run the new + existing view tests**

Run: `pnpm vitest run app/[token]/SessionPageView.test.tsx app/[token]/SessionPageView.threads.test.tsx`
Expected: PASS (including the two new cases). If a `renderView` helper does not exist, adapt the two new tests to the file's existing prop-construction pattern before running.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no errors. (`SessionHeader` will still type-error on the two new props until Task 7 — if so, do Task 7 Step 3 before re-running, or temporarily mark them optional. Prefer completing Task 7.)

- [ ] **Step 6: Commit**

```bash
git add app/[token]/SessionPageView.tsx app/[token]/SessionPageView.test.tsx
git commit -m "feat: mount DeviceHandoff and derive connection state in session view"
```

---

### Task 7: Replace the header peer badge with `ConnectionPill`

**Files:**
- Modify: `components/SessionHeader.tsx` (props interface + the `peers.length > 0` badge block at lines 501-564)
- Test: `components/SessionHeader.test.tsx` (update badge-text assertions)

**Interfaces:**
- Consumes: `ConnectionPill` from `./ConnectionPill`; `ConnectionState` from `@/lib/connection-state`; new props `connectionState` and `connectionPulse` supplied by Task 6.
- Produces: no downstream interface changes.

- [ ] **Step 1: Update the failing test**

In `components/SessionHeader.test.tsx`, any render helper that builds `SessionHeader` props must now include `connectionState` (and optionally `connectionPulse`). Add/adjust:
```tsx
// In the default props builder, add:
//   connectionState: "waiting",
// For the connected case, set peers + connectionState: "connected-direct".

test("shows the connected peer name in the header pill", () => {
  const view = renderHeader({
    peers: [{ peerId: "p1", channelState: "open", hasTunnel: false }],
    peerNames: { p1: "Laptop" },
    directPeerCount: 1,
    connectionState: "connected-direct",
  });
  expect(view.getByText("Laptop")).toBeTruthy();
});
```
Replace any existing assertion for the old text (e.g. `"1 direct peer"` / `"2 direct peers"`) with the pill label equivalents (`"Laptop"` or `"2 devices"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/SessionHeader.test.tsx`
Expected: FAIL — `connectionState` prop missing / old text assertions.

- [ ] **Step 3: Implement**

In `components/SessionHeader.tsx`:

Add imports:
```ts
import { ConnectionPill } from "./ConnectionPill";
import type { ConnectionState } from "@/lib/connection-state";
```

Add to `SessionHeaderProps` (after `directPeerCount: number;`):
```ts
  connectionState: ConnectionState;
  connectionPulse?: boolean;
```
Destructure them in the component signature (add alongside `directPeerCount`):
```ts
  connectionState,
  connectionPulse,
```

Replace the entire peer-badge block (lines 501-564, the `{peers.length > 0 && ( ... )}` expression that renders the `"N direct peers"` button and its dropdown) with:
```tsx
        {connectionState !== "waiting" && (
          <div className="relative" ref={peerListRef}>
            <ConnectionPill
              state={connectionState}
              peers={peers}
              peerNames={peerNames}
              pulse={connectionPulse}
              onClick={openPeerMenu}
            />
            {peerListOpen && peers.length > 0 && (
              <div className="absolute top-full left-0 mt-1 z-10 rounded-md border border-neutral-700 bg-neutral-800 p-2 text-xs shadow-lg min-w-[200px]">
                {allPeers.map((p) => (
                  <div key={p.peerId} className="flex items-center gap-2 py-0.5 group">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${channelDot(p.channelState)}`} />
                    {editingPeerId === p.peerId ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") setEditingPeerId(null);
                        }}
                        className="bg-neutral-900 border border-neutral-600 rounded px-1 py-0 text-xs text-neutral-200 w-24 outline-none focus:border-emerald-500"
                        maxLength={20}
                      />
                    ) : (
                      <button
                        onClick={() => startEditing(p.peerId)}
                        className="min-w-0 text-left hover:text-emerald-300 transition-colors cursor-pointer"
                        title="Click to rename"
                      >
                        <span className="block font-mono text-neutral-300">
                          {peerDisplayName(p, peerNames, p.isLocal)}
                        </span>
                        <span className="block font-mono text-[10px] text-neutral-500">
                          id {peerDisplayId(p.peerId)}
                        </span>
                      </button>
                    )}
                    {!p.isLocal && p.channelState === "open" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onPingPeer(p.peerId); }}
                        className="ml-auto px-1.5 py-0 rounded text-[10px] text-neutral-400 hover:text-emerald-300 hover:bg-emerald-950/40 transition-colors cursor-pointer"
                        title="Ping this device"
                      >
                        ping
                      </button>
                    )}
                    {!p.isLocal && (
                      <span className="text-neutral-500">{channelLabel(p.channelState)}</span>
                    )}
                    {p.isLocal && (
                      <span className="text-neutral-600 italic">this device</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
```
> This preserves the existing peer dropdown verbatim — only the trigger changed from the old badge to `ConnectionPill`, and the outer guard changed from `peers.length > 0` to `connectionState !== "waiting"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/SessionHeader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full type-check + lint**

Run: `pnpm tsc --noEmit && pnpm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/SessionHeader.tsx components/SessionHeader.test.tsx
git commit -m "feat: replace peer badge with ConnectionPill in header"
```

---

### Task 8: Full suite + manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend suite**

Run: `pnpm vitest run`
Expected: all green.

- [ ] **Step 2: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm run lint`
Expected: clean.

- [ ] **Step 3: Manual walkthrough (dev server)**

Run: `make dev PORT=3001` then open `http://localhost:3001`.
Verify, in one browser:
1. Create a new session → the **center QR panel** fills the empty thread with "Waiting for your other device…". Header shows **no** connection pill.
2. Paste a text clip → panel collapses to the **slim banner** ("No device linked yet · Show QR · Copy URL · ✕") above the clip. ✕ hides it; reload the tab → still hidden (sessionStorage); open the session in a fresh tab/session → banner returns.
3. Open the same session URL in a second browser/profile → header pill goes **amber "Linking…"** then **emerald "{peer name or 'device'}"**; the panel/banner disappears; a screen reader (or the `sr-only` region in DOM) announces "Device connected".
4. Click the emerald pill → the existing peer dropdown (rename / ping / id) still works.

- [ ] **Step 4: Commit any fixes, then stop for review**

If manual verification surfaced spacing/redundancy issues (e.g. the empty PasteZone hint reads awkwardly beneath the center panel), adjust `DeviceHandoff` / `SessionPageView` spacing, re-run `pnpm vitest run`, and commit. Otherwise the branch is ready for PR.

---

## Self-Review

**Spec coverage:**
- Derived state (spec §1) → Task 1. ✓ (Rule tightened: any present-but-not-open peer is `connecting`, so `waiting` is exactly zero peers + zero tunnels — removes a negotiation-time blank gap; strictly better than the spec's literal "some channelState 'connecting'".)
- Center panel / slim banner / connecting text (spec §2) → Task 5, mounted in Task 6. ✓
- Header pill with peer name, counts, `· relay`, waiting→nothing (spec §3) → Tasks 3 + 7. ✓
- Transition feel: pulse ring + `aria-live` announcement (spec §4) → Task 3 (`pulse` prop) + Task 6 (`sr-only` region, `connectionPulse` timer). ✓
- Reuse `QRCodeSVG` / `QRCodeModal` (spec §5) → Task 4 (`QRCode` wraps `QRCodeSVG`), Task 5 (banner reuses `QRCodeModal`). ✓
- Testing plan (spec) → each task is TDD; Task 8 runs the full suite + manual walkthrough. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one conditional instruction (`sr-only` fallback, `renderView`/`renderHeader` helper adaptation) gives the exact alternative to use.

**Type consistency:** `ConnectionState` union identical across Tasks 1/3/5/6/7. `deriveConnectionState` input `{ peers, readyPeerCount, tunnels }` matches `SessionPageView`'s available props. `ConnectionPill` props (`state`, `peers`, `peerNames`, `pulse`, `onClick`) match the call site in Task 7. `DeviceHandoff` props (`state`, `sessionUrl`, `token`, `hasClips`) match the call site in Task 6. `getSessionUrl(token: string)` signature identical in Tasks 2/6.
