"use client";

// Security (H2/H4): authorization policy for peer-initiated clip mutations in the
// WebRTC mesh. The session has no server authority, so a peer must not be able to
// delete, overwrite, or resurrect clips it does not legitimately own.
//
// "Source" = the peer whose `clip:start` for this transfer we accepted. The first
// accepted clip:start wins (dedup in the store), so an attacker cannot become the
// source of a clip the real owner already delivered, and a peer that merely learned
// a transferId from someone else's catalog never becomes its source.

// H4a: never re-create a clip that was deleted (tombstoned) in this session.
export function mayAcceptClipStart(opts: { tombstoned: boolean }): boolean {
  return !opts.tombstoned;
}

// H4b: only the peer that delivered the clip may replace its contents, and never
// onto a tombstoned id. Blocks the "swap a benign clip for a malicious one" attack.
export function mayReplaceClip(opts: {
  sourcePeerId: string | undefined;
  senderPeerId: string;
  tombstoned: boolean;
}): boolean {
  if (opts.tombstoned) return false;
  return opts.sourcePeerId !== undefined && opts.sourcePeerId === opts.senderPeerId;
}

// H2: only the peer that delivered the clip may delete and tombstone it. Blocks a
// peer from wiping clips it merely learned about (e.g. from another peer's catalog).
export function mayDeleteClip(opts: {
  sourcePeerId: string | undefined;
  senderPeerId: string;
}): boolean {
  return opts.sourcePeerId !== undefined && opts.sourcePeerId === opts.senderPeerId;
}
