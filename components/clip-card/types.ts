import type { Clip } from "@/lib/clips";
import type { TransferStats } from "@/lib/direct-transfer";
import type { SecretHandle } from "@/lib/clip-crypto";

export interface ClipCardProps {
  clip: Clip;
  token: string;
  expiresAt: string;
  canCopyImage: boolean;
  getDirectClipCiphertext: (clipId: number) => Uint8Array | null;
  getSendProgress: (transferId: string) => number | null;
  getTransferStats: (transferId: string) => TransferStats | null;
  readyPeerCount: number;
  unlockSecret: string | null;
  secretHandle?: SecretHandle | null;
  requestUnlockSecret: () => Promise<string | null>;
  onDelete: (clip: Clip) => void;
  onUpdateContent?: (input: {
    transferId: string;
    kind: "text" | "html";
    text: string;
  }) => Promise<void>;
  subscribeToSendProgress: (listener: () => void) => () => void;
  subscribeToDirectTransfers: (listener: () => void) => () => void;
}

export type FileReadyState = "none" | "decrypting" | "ready" | "error";
