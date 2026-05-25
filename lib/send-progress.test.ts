import { describe, expect, test, vi } from "vitest";
import { SendProgressStore } from "./send-progress";

describe("SendProgressStore", () => {
  test("aggregates sender progress by the slowest active peer", () => {
    const store = new SendProgressStore();

    store.startPeerSend("transfer-1", "peer-a", 100);
    store.startPeerSend("transfer-1", "peer-b", 100);
    store.updatePeerProgress("transfer-1", "peer-a", 90);
    store.updatePeerProgress("transfer-1", "peer-b", 40);

    expect(store.getTransferProgress("transfer-1")).toBe(0.4);
  });

  test("drops failed or disconnected peers and clears idle transfers", () => {
    const store = new SendProgressStore();

    store.startPeerSend("transfer-1", "peer-a", 100);
    store.startPeerSend("transfer-1", "peer-b", 100);
    store.updatePeerProgress("transfer-1", "peer-a", 50);
    store.updatePeerProgress("transfer-1", "peer-b", 25);

    store.failPeerSend("transfer-1", "peer-b");
    expect(store.getTransferProgress("transfer-1")).toBe(0.5);

    store.clearPeer("peer-a");
    expect(store.getTransferProgress("transfer-1")).toBeNull();
  });

  test("updatePeerProgress is a no-op for unknown transfer", () => {
    const store = new SendProgressStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.updatePeerProgress("unknown-transfer", "peer-a", 50);
    expect(listener).not.toHaveBeenCalled();
  });

  test("updatePeerProgress is a no-op for unknown peer within known transfer", () => {
    const store = new SendProgressStore();
    store.startPeerSend("transfer-1", "peer-a", 100);

    const listener = vi.fn();
    store.subscribe(listener);

    store.updatePeerProgress("transfer-1", "peer-unknown", 50);
    expect(listener).not.toHaveBeenCalled();
  });

  test("clearPeer does not emit when peer is not in any transfer", () => {
    const store = new SendProgressStore();
    store.startPeerSend("transfer-1", "peer-a", 100);

    const listener = vi.fn();
    store.subscribe(listener);

    store.clearPeer("peer-unknown");
    expect(listener).not.toHaveBeenCalled();
  });

  test("clearAll is a no-op when no transfers exist", () => {
    const store = new SendProgressStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.clearAll();
    expect(listener).not.toHaveBeenCalled();
  });

  test("getTransferProgress skips peers with zero totalBytes", () => {
    const store = new SendProgressStore();

    store.startPeerSend("transfer-1", "peer-a", 0);
    store.startPeerSend("transfer-1", "peer-b", 100);
    store.updatePeerProgress("transfer-1", "peer-b", 75);

    // peer-a has totalBytes=0 so it is skipped; only peer-b matters
    expect(store.getTransferProgress("transfer-1")).toBe(0.75);
  });

  test("getTransferProgress returns 1 when all peers have zero totalBytes", () => {
    const store = new SendProgressStore();

    store.startPeerSend("transfer-1", "peer-a", 0);
    // slowestProgress starts at 1 and nothing reduces it
    expect(store.getTransferProgress("transfer-1")).toBe(1);
  });

  test("deletePeerSend (via finishPeerSend) is a no-op for unknown peer", () => {
    const store = new SendProgressStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.finishPeerSend("unknown-transfer", "peer-a");
    expect(listener).not.toHaveBeenCalled();
  });

  test("clearPeer removes peer but keeps transfer when other peers remain", () => {
    const store = new SendProgressStore();

    store.startPeerSend("transfer-1", "peer-a", 100);
    store.startPeerSend("transfer-1", "peer-b", 100);
    store.updatePeerProgress("transfer-1", "peer-a", 50);

    store.clearPeer("peer-a");
    // transfer-1 still exists because peer-b remains
    expect(store.getTransferProgress("transfer-1")).not.toBeNull();
  });

  test("notifies subscribers and clears all active sends", () => {
    const store = new SendProgressStore();
    let callCount = 0;
    const unsubscribe = store.subscribe(() => {
      callCount += 1;
    });

    store.startPeerSend("transfer-1", "peer-a", 10);
    store.updatePeerProgress("transfer-1", "peer-a", 5);
    store.clearAll();

    expect(callCount).toBe(3);
    expect(store.getTransferProgress("transfer-1")).toBeNull();

    unsubscribe();
  });
});
