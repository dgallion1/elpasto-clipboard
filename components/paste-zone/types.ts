import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Clip } from "@/lib/clips";
import type { ClipZone } from "@/lib/clips";
import type { TransferStats } from "@/lib/direct-transfer";
import type { ImportEntry } from "@/hooks/useSessionHistory";
import type { SecretHandle } from "@/lib/clip-crypto";

export interface ImportSessionsResult {
  importedCount: number;
  createdCount: number;
  existingCount: number;
  invalidCount: number;
  capacityCount: number;
  usedFallback: boolean;
}

export interface PasteZoneProps {
  zone: ClipZone;
  threadName?: string;
  clips: Clip[];
  token: string;
  expiresAt: string;
  canCopyImage: boolean;
  getDirectClipCiphertext: (clipId: number) => Uint8Array | null;
  getSendProgress: (transferId: string) => number | null;
  getTransferStats: (transferId: string) => TransferStats | null;
  readyPeerCount: number;
  unlockSecret: string | null;        // kept for backward compat
  secretHandle?: SecretHandle | null;  // preferred when present
  requestUnlockSecret: () => Promise<string | null>;
  onClipAdded: (clip: Clip) => void;
  onClipDeleted: (clip: Clip) => void;
  onUpdateClipContent?: (input: {
    transferId: string;
    kind: "text" | "html";
    text: string;
  }) => Promise<void>;
  onQueueLocalBinaryClip: (input: {
    transferId: string;
    zone: ClipZone;
    file: File;
    secret?: string;
    secretHandle?: SecretHandle;
    kind?: "text" | "html" | "image" | "file";
  }) => Promise<Clip>;
  onClearZone: () => Promise<void>;
  focusedZone: ClipZone | null;
  onFocusZone: (zone: ClipZone | null) => void;
  subscribeToSendProgress: (listener: () => void) => () => void;
  subscribeToDirectTransfers: (listener: () => void) => () => void;
  onImportSessions?: (entries: ImportEntry[]) => Promise<ImportSessionsResult>;
}

export interface PasteZoneActionState {
  fileInputRef: RefObject<HTMLInputElement | null>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsClearing: Dispatch<SetStateAction<boolean>>;
  setIsDragOver: Dispatch<SetStateAction<boolean>>;
  onSessionImportDetected: (entries: ImportEntry[]) => void;
}
