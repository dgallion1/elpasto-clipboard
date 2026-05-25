"use client";

export interface PeerSignalMessage {
  fromPeerId: string;
  toPeerId?: string;
  signalType: "announce" | "leave" | "description" | "ice-candidate";
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}
