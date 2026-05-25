import type { Clip } from "@/lib/clips";
import { sortClipsNewestFirst } from "@/lib/clips";

export function mergeClips(...sources: Clip[][]): Clip[] {
  const merged = new Map<string, Clip>();
  const signatureToKey = new Map<string, string>();

  for (const source of sources) {
    for (const clip of source) {
      const primaryKey = clip.client_transfer_id
        ? `transfer:${clip.client_transfer_id}`
        : `id:${clip.id}`;
      const signature = (clip.kind === "image" || clip.kind === "file")
        ? `${clip.zone}:${clip.kind}:${clip.original_name}:${clip.created_at}:${clip.size_bytes ?? 0}`
        : null;
      const existingKeyBySignature = signature ? signatureToKey.get(signature) : undefined;
      const key = existingKeyBySignature && existingKeyBySignature !== primaryKey
        ? existingKeyBySignature
        : primaryKey;

      if (signature && !signatureToKey.has(signature)) {
        signatureToKey.set(signature, key);
      }

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, clip);
        continue;
      }

      if (existing.local_only && !clip.local_only) {
        merged.set(key, clip);
      }
      // Prefer sender clips (which carry local_file) over receiver stubs
      if (existing.local_origin === "receiver" && clip.local_origin === "sender") {
        merged.set(key, clip);
      }
    }
  }

  return Array.from(merged.values()).sort(sortClipsNewestFirst);
}
