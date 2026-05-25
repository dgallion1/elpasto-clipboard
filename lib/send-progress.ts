"use client";

interface PeerSendProgress {
  sentBytes: number;
  totalBytes: number;
}

export class SendProgressStore {
  private readonly listeners = new Set<() => void>();
  private readonly transfers = new Map<string, Map<string, PeerSendProgress>>();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startPeerSend(transferId: string, peerId: string, totalBytes: number) {
    const peers = this.transfers.get(transferId) ?? new Map<string, PeerSendProgress>();
    peers.set(peerId, {
      sentBytes: 0,
      totalBytes,
    });
    this.transfers.set(transferId, peers);
    this.emit();
  }

  updatePeerProgress(transferId: string, peerId: string, sentBytes: number) {
    const peers = this.transfers.get(transferId);
    const current = peers?.get(peerId);
    if (!peers || !current) {
      return;
    }

    current.sentBytes = sentBytes;
    this.emit();
  }

  finishPeerSend(transferId: string, peerId: string) {
    this.deletePeerSend(transferId, peerId);
  }

  failPeerSend(transferId: string, peerId: string) {
    this.deletePeerSend(transferId, peerId);
  }

  clearPeer(peerId: string) {
    let changed = false;
    for (const [transferId, peers] of this.transfers.entries()) {
      if (!peers.delete(peerId)) {
        continue;
      }
      changed = true;
      if (peers.size === 0) {
        this.transfers.delete(transferId);
      }
    }
    if (changed) {
      this.emit();
    }
  }

  clearAll() {
    if (this.transfers.size === 0) {
      return;
    }
    this.transfers.clear();
    this.emit();
  }

  getTransferProgress(transferId: string): number | null {
    const peers = this.transfers.get(transferId);
    if (!peers || peers.size === 0) {
      return null;
    }

    let slowestProgress = 1;
    for (const progress of peers.values()) {
      if (progress.totalBytes <= 0) {
        continue;
      }
      slowestProgress = Math.min(
        slowestProgress,
        Math.min(Math.max(progress.sentBytes / progress.totalBytes, 0), 1)
      );
    }

    return slowestProgress;
  }

  private deletePeerSend(transferId: string, peerId: string) {
    const peers = this.transfers.get(transferId);
    if (!peers?.delete(peerId)) {
      return;
    }

    if (peers.size === 0) {
      this.transfers.delete(transferId);
    }
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
