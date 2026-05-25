"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ClipCryptoError,
  decryptBinaryPayload,
  decryptHtmlPayload,
  decryptTextPayload,
  decryptTextWithHandle,
  decryptHtmlWithHandle,
  decryptBinaryWithHandle,
  toArrayBuffer,
} from "@/lib/clip-crypto";
import type { SecretHandle } from "@/lib/clip-crypto";
import type { ClipEncryptionMeta } from "@/lib/clip-encryption";
import type { ClipEncryptionMetaV1 } from "@/lib/clip-encryption";
import { buildApiUrl } from "@/lib/api";
import {
  copyHtml,
  copyImageBlob,
  copyImageFromUrl,
  copyText,
} from "@/hooks/useClipboard";
import {
  downloadBlob,
  loadEncryptedFile,
  resolveDecryptError,
  useCountdown,
} from "./helpers";
import type { ClipCardProps, FileReadyState } from "./types";

export function useClipCardController({
  clip,
  token,
  expiresAt,
  canCopyImage,
  getDirectClipCiphertext,
  getSendProgress,
  getTransferStats,
  readyPeerCount,
  unlockSecret,
  secretHandle,
  requestUnlockSecret,
  onDelete,
  subscribeToSendProgress,
  subscribeToDirectTransfers,
}: ClipCardProps) {
  const [copyState, setCopyState] = useState("");
  const [deleteError, setDeleteError] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decryptedText, setDecryptedText] = useState<string | null>(null);
  const [decryptedHtml, setDecryptedHtml] = useState<string | null>(null);
  const [decryptedImageBlob, setDecryptedImageBlob] = useState<Blob | null>(null);
  const [decryptedImageUrl, setDecryptedImageUrl] = useState<string | null>(null);
  const [localImageUrl, setLocalImageUrl] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [decryptedFileBlob, setDecryptedFileBlob] = useState<Blob | null>(null);
  const decryptedImageUrlRef = useRef<string | null>(null);
  const localImageUrlRef = useRef<string | null>(null);

  const localFile = clip.local_file ?? null;
  const fileUrl = clip.storage_key
    ? buildApiUrl(`/api/files/${token}/${clip.id}`)
    : null;
  const remaining = useCountdown(expiresAt);
  const directCiphertext = useSyncExternalStore(
    subscribeToDirectTransfers,
    () => getDirectClipCiphertext(clip.id),
    () => null
  );
  const awaitingDirectTransfer =
    clip.local_only === true &&
    clip.local_origin === "receiver" &&
    clip.local_transfer_state !== "complete" &&
    !directCiphertext;
  const peerAvailableForTransfer = awaitingDirectTransfer && readyPeerCount > 0;
  const transferStats = useSyncExternalStore(
    subscribeToDirectTransfers,
    () => (clip.client_transfer_id ? getTransferStats(clip.client_transfer_id) : null),
    () => null
  );
  const sendProgress = useSyncExternalStore(
    subscribeToSendProgress,
    () => (clip.client_transfer_id ? getSendProgress(clip.client_transfer_id) : null),
    () => null
  );

  const setPreviewBlob = useCallback((blob: Blob | null) => {
    if (decryptedImageUrlRef.current) {
      URL.revokeObjectURL(decryptedImageUrlRef.current);
      decryptedImageUrlRef.current = null;
    }

    setDecryptedImageBlob(blob);

    if (!blob) {
      setDecryptedImageUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(blob);
    decryptedImageUrlRef.current = nextUrl;
    setDecryptedImageUrl(nextUrl);
  }, []);

  useEffect(() => {
    return () => {
      if (decryptedImageUrlRef.current) {
        URL.revokeObjectURL(decryptedImageUrlRef.current);
      }
      if (localImageUrlRef.current) {
        URL.revokeObjectURL(localImageUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (localImageUrlRef.current) {
      URL.revokeObjectURL(localImageUrlRef.current);
      localImageUrlRef.current = null;
    }

    if (clip.kind === "image" && localFile) {
      const url = URL.createObjectURL(localFile);
      localImageUrlRef.current = url;
      setLocalImageUrl(url);
      return;
    }

    setLocalImageUrl(null);
  }, [clip.kind, localFile]);

  const ensureUnlockSecret = useCallback(async () => {
    return unlockSecret ?? requestUnlockSecret();
  }, [requestUnlockSecret, unlockSecret]);

  const resolveSecretHandle = useCallback((secretOverride?: string | null): SecretHandle | null => {
    if (secretOverride) return { mode: "normal", secret: secretOverride };
    if (secretHandle) return secretHandle;
    if (unlockSecret) return { mode: "normal", secret: unlockSecret };
    return null;
  }, [secretHandle, unlockSecret]);

  const getUnencryptedDirectBlob = useCallback((): Blob | null => {
    if (clip.encrypted || !directCiphertext) {
      return null;
    }
    return new Blob([toArrayBuffer(directCiphertext)], {
      type: clip.mime_type || "application/octet-stream",
    });
  }, [clip.encrypted, clip.mime_type, directCiphertext]);

  const decryptBinaryClip = useCallback(
    async (secretOverride?: string | null): Promise<Blob> => {
      if (localFile) {
        return new Blob([await localFile.arrayBuffer()], {
          type: clip.mime_type || localFile.type || "application/octet-stream",
        });
      }

      if (!clip.encrypted || !clip.encryption_meta || (!fileUrl && !directCiphertext)) {
        throw new ClipCryptoError(
          "Encrypted file clip is missing ciphertext or metadata"
        );
      }

      const ciphertext = directCiphertext
        ? directCiphertext
        : await loadEncryptedFile(fileUrl);

      const handle = resolveSecretHandle(secretOverride);
      let plaintextBytes: Uint8Array;
      if (!handle) {
        const raw = await ensureUnlockSecret();
        if (!raw) throw new ClipCryptoError("Unlock secret required to decrypt binary");
        plaintextBytes = await decryptBinaryWithHandle(
          { mode: "normal", secret: raw },
          ciphertext,
          clip.encryption_meta as ClipEncryptionMeta,
          requestUnlockSecret
        );
      } else {
        plaintextBytes = await decryptBinaryWithHandle(
          handle,
          ciphertext,
          clip.encryption_meta as ClipEncryptionMeta,
          requestUnlockSecret
        );
      }

      return new Blob([toArrayBuffer(plaintextBytes)], {
        type: clip.mime_type || "application/octet-stream",
      });
    },
    [
      clip.encrypted,
      clip.encryption_meta,
      clip.mime_type,
      directCiphertext,
      ensureUnlockSecret,
      fileUrl,
      localFile,
      requestUnlockSecret,
      resolveSecretHandle,
    ]
  );

  const loadUnencryptedBinaryClip = useCallback(async (): Promise<Blob> => {
    if (localFile) {
      return new Blob([await localFile.arrayBuffer()], {
        type: clip.mime_type || localFile.type || "application/octet-stream",
      });
    }

    if (directCiphertext) {
      return new Blob([toArrayBuffer(directCiphertext)], {
        type: clip.mime_type || "application/octet-stream",
      });
    }

    if (fileUrl) {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error("Failed to load binary clip");
      const blob = await res.blob();
      return new Blob([await blob.arrayBuffer()], {
        type: clip.mime_type || blob.type || "application/octet-stream",
      });
    }

    throw new Error("No source available for binary clip");
  }, [clip.mime_type, directCiphertext, fileUrl, localFile]);

  const loadTextContent = useCallback(async (secretOverride?: string | null): Promise<string | null> => {
    if (localFile) {
      return localFile.text();
    }

    if (clip.encrypted) {
      if (clip.text_content && clip.encryption_meta && !directCiphertext && !fileUrl) {
        const handle = resolveSecretHandle(secretOverride);
        if (!handle) {
          const raw = await ensureUnlockSecret();
          if (!raw) throw new ClipCryptoError("Unlock secret required to decrypt text");
          return decryptTextWithHandle({ mode: "normal", secret: raw }, clip.text_content, clip.encryption_meta!, requestUnlockSecret);
        }
        return decryptTextWithHandle(handle, clip.text_content, clip.encryption_meta!, requestUnlockSecret);
      }

      const blob = await decryptBinaryClip(secretOverride);
      return blob.text();
    }

    if (directCiphertext) {
      const blob = getUnencryptedDirectBlob();
      return blob ? blob.text() : "";
    }

    if (fileUrl) {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error("Failed to load text content");
      return res.text();
    }

    // Return actual text_content if available, otherwise null to signal
    // that content hasn't loaded yet (e.g. directCiphertext pending).
    return clip.text_content || null;
  }, [
    clip.encrypted,
    clip.encryption_meta,
    clip.text_content,
    decryptBinaryClip,
    directCiphertext,
    ensureUnlockSecret,
    fileUrl,
    getUnencryptedDirectBlob,
    localFile,
    requestUnlockSecret,
    resolveSecretHandle,
  ]);

  const loadHtmlContent = useCallback(async (
    secretOverride?: string | null
  ): Promise<{ text: string; html: string } | null> => {
    if (localFile || directCiphertext || fileUrl) {
      const rawText = await loadTextContent(secretOverride);
      if (rawText === null) return null;
      if (!rawText) return { text: "", html: "" };

      try {
        return JSON.parse(rawText) as { text: string; html: string };
      } catch {
        return { text: rawText, html: "" };
      }
    }

    if (clip.encrypted) {
      if (!clip.text_content || !clip.encryption_meta) {
        throw new ClipCryptoError(
          "Encrypted HTML clip is missing ciphertext or metadata"
        );
      }

      const handle = resolveSecretHandle(secretOverride);
      let json: string;
      if (!handle) {
        const raw = await ensureUnlockSecret();
        if (!raw) throw new ClipCryptoError("Unlock secret required to decrypt HTML");
        json = await decryptHtmlWithHandle({ mode: "normal", secret: raw }, clip.text_content, clip.encryption_meta!, requestUnlockSecret);
      } else {
        json = await decryptHtmlWithHandle(handle, clip.text_content, clip.encryption_meta!, requestUnlockSecret);
      }
      return JSON.parse(json) as { text: string; html: string };
    }

    // Return actual content if available, otherwise null to signal
    // that content hasn't loaded yet (e.g. directCiphertext pending).
    if (!clip.text_content && !clip.html_content) return null;
    return {
      text: clip.text_content || "",
      html: clip.html_content || "",
    };
  }, [
    clip.encrypted,
    clip.encryption_meta,
    clip.html_content,
    clip.text_content,
    directCiphertext,
    ensureUnlockSecret,
    fileUrl,
    loadTextContent,
    localFile,
    requestUnlockSecret,
    resolveSecretHandle,
  ]);

  useEffect(() => {
    if (
      clip.encrypted &&
      (clip.kind === "image" || clip.kind === "file") &&
      directCiphertext
    ) {
      setDecryptError(null);
    }
  }, [clip.encrypted, clip.kind, directCiphertext]);

  useEffect(() => {
    let cancelled = false;
    setDecryptError(null);
    setDecryptedText(null);
    setDecryptedHtml(null);
    setPreviewBlob(null);
    setDecryptedFileBlob(null);

    if (clip.encrypted && !unlockSecret && !secretHandle) {
      setIsDecrypting(false);
      return;
    }

    if (clip.kind === "text") {
      setIsDecrypting(clip.encrypted);
      void loadTextContent()
        .then((text) => {
          if (!cancelled) {
            setDecryptedText(text);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setDecryptError(resolveDecryptError(error));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsDecrypting(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (clip.kind === "html") {
      setIsDecrypting(clip.encrypted);
      void loadHtmlContent()
        .then((result) => {
          if (!cancelled && result) {
            setDecryptedText(result.text);
            setDecryptedHtml(result.html);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setDecryptError(resolveDecryptError(error));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsDecrypting(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (clip.kind === "image" || clip.kind === "file") {
      if (!localFile && !directCiphertext && !fileUrl) {
        setIsDecrypting(false);
        return;
      }

      setIsDecrypting(clip.encrypted);
      
      // Unencrypted sender-local or server-backed images already have a stable URL.
      // Receiver-local direct-transfer images still need a blob URL synthesized here.
      if (!clip.encrypted && clip.kind === "image" && !directCiphertext) {
        setIsDecrypting(false);
        return;
      }
      
      const loadBinary = clip.encrypted ? decryptBinaryClip() : loadUnencryptedBinaryClip();
       
      void loadBinary
        .then((blob) => {
          if (!cancelled) {
            if (clip.kind === "image") {
              setPreviewBlob(blob);
            }
            setDecryptedFileBlob(blob);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setDecryptError(resolveDecryptError(error));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsDecrypting(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    setIsDecrypting(false);
  }, [
    clip.encrypted,
    clip.kind,
    decryptBinaryClip,
    loadHtmlContent,
    loadTextContent,
    loadUnencryptedBinaryClip,
    directCiphertext,
    fileUrl,
    localFile,
    setPreviewBlob,
    unlockSecret,
    secretHandle,
  ]);

  const flashCopyState = (message: string) => {
    setCopyState(message);
    setTimeout(() => setCopyState(""), 2000);
  };

  const handleCopy = async () => {
    let result = false;

    try {
      switch (clip.kind) {
        case "text": {
          const handle = resolveSecretHandle();
          if (clip.encrypted && !handle) {
            const raw = await ensureUnlockSecret();
            if (!raw) return;
            const text = await loadTextContent(raw);
            result = await copyText(text || "");
          } else {
            const text = await loadTextContent();
            result = await copyText(text || "");
          }
          flashCopyState(result ? "Copied!" : "Failed");
          return;
        }
        case "html": {
          const handle = resolveSecretHandle();
          if (clip.encrypted && !handle) {
            const raw = await ensureUnlockSecret();
            if (!raw) return;
            const htmlResult =
              decryptedHtml && decryptedText
                ? { text: decryptedText, html: decryptedHtml }
                : await loadHtmlContent(raw);
            const { text, html } = htmlResult ?? { text: "", html: "" };
            const copyResult = await copyHtml(html || text || "", text || "");
            if (copyResult === "rich") {
              flashCopyState("Copied rich text");
            } else if (copyResult === "plain") {
              flashCopyState("Copied as plain text");
            } else {
              flashCopyState("Failed");
            }
          } else {
            const htmlResult =
              decryptedHtml && decryptedText
                ? { text: decryptedText, html: decryptedHtml }
                : await loadHtmlContent();
            const { text, html } = htmlResult ?? { text: "", html: "" };
            const copyResult = await copyHtml(html || text || "", text || "");
            if (copyResult === "rich") {
              flashCopyState("Copied rich text");
            } else if (copyResult === "plain") {
              flashCopyState("Copied as plain text");
            } else {
              flashCopyState("Failed");
            }
          }
          return;
        }
        case "image": {
          if (!canCopyImage) {
            return;
          }

          if (localFile) {
            result = await copyImageBlob(localFile);
          } else if (decryptedImageBlob) {
            result = await copyImageBlob(decryptedImageBlob);
          } else if (clip.encrypted) {
            const blob = await decryptBinaryClip();
            result = await copyImageBlob(blob);
          } else if (fileUrl) {
            result = await copyImageFromUrl(fileUrl);
          }

          flashCopyState(result ? "Copied!" : "Failed");
          return;
        }
      }
    } catch (error) {
      setDecryptError(resolveDecryptError(error));
      flashCopyState("Failed");
    }
  };

  const handleDelete = async () => {
    setDeleteError(false);
    onDelete(clip);
  };

  const handleUnlock = async () => {
    const secret = await requestUnlockSecret();
    if (!secret) {
      return;
    }
    setDecryptError(null);
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    setDecryptError(null);

    try {
      if (localFile && !clip.encrypted) {
        await downloadBlob(localFile, clip.original_name || localFile.name || "download");
        return;
      }

      if (decryptedFileBlob) {
        await downloadBlob(decryptedFileBlob, clip.original_name || "download");
        return;
      }

      if (!clip.encrypted && directCiphertext) {
        const blob = getUnencryptedDirectBlob();
        if (blob) {
          await downloadBlob(blob, clip.original_name || "download");
          return;
        }
      }

      if (clip.encrypted) {
        const blob = await decryptBinaryClip();
        await downloadBlob(blob, clip.original_name || "download");
        return;
      }

      if (fileUrl) {
        const anchor = document.createElement("a");
        anchor.href = fileUrl;
        anchor.download = clip.original_name || "download";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch (error) {
      setDecryptError(resolveDecryptError(error));
    } finally {
      setIsDownloading(false);
    }
  };

  const showDownloadButton = Boolean(
    localFile ||
      fileUrl ||
      directCiphertext ||
      (clip.encrypted && (clip.kind === "image" || clip.kind === "file"))
  );
  const fileReadyState: FileReadyState =
    clip.kind === "file"
      ? isDecrypting
        ? "decrypting"
        : decryptedFileBlob
          ? "ready"
          : decryptError
            ? "error"
            : "none"
      : "none";

  return {
    awaitingDirectTransfer,
    copyState,
    decryptError,
    decryptedFileBlob,
    decryptedHtml,
    decryptedImageUrl,
    decryptedText,
    deleteError,
    fileReadyState,
    fileUrl,
    handleCopy,
    handleDelete,
    handleDownload,
    handleUnlock,
    isDecrypting,
    isDownloading,
    localFile,
    localImageUrl,
    peerAvailableForTransfer,
    remaining,
    sendProgress,
    showDownloadButton,
    transferStats,
    unlockSecret,
  };
}
