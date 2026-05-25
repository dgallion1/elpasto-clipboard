import type { ClipEncryptionMeta } from "./clip-encryption";

export type ThreadId = string;
export type ClipZone = ThreadId;
export type ClipKind = "text" | "html" | "image" | "file";

export interface Clip {
  id: number;
  session_id: number;
  zone: ClipZone;
  kind: ClipKind;
  client_transfer_id: string | null;
  mime_type: string | null;
  text_content: string | null;
  html_content: string | null;
  storage_key: string | null;
  original_name: string | null;
  size_bytes: number | null;
  encrypted: boolean;
  encryption_version: number | null;
  encryption_meta: ClipEncryptionMeta | null;
  created_at: string;
  local_only?: boolean;
  local_origin?: "sender" | "receiver" | null;
  local_transfer_state?: "pending" | "complete" | "failed" | null;
  note?: string | null;
  local_file?: File | null;
}

export function sortClipsNewestFirst(a: Clip, b: Clip): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}
