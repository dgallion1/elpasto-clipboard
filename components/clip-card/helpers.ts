import { useSyncExternalStore } from "react";
import type { Clip } from "@/lib/clips";
import {
  ClipCryptoError,
  WrongUnlockSecretError,
} from "@/lib/clip-crypto";
import { parseUtcTimestamp } from "@/lib/time";

const SAFE_HTML_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const SAFE_HTML_TAG_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

const DANGEROUS_HTML_BLOCK_TAGS = [
  "button",
  "form",
  "iframe",
  "input",
  "link",
  "meta",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "textarea",
];

const DANGEROUS_HTML_BLOCK_REGEX = new RegExp(
  `<\\s*(${DANGEROUS_HTML_BLOCK_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`,
  "gi"
);

const DANGEROUS_HTML_SINGLE_TAG_REGEX =
  /<\s*(base|embed|frame|frameset|img|source)\b[^>]*\/?>/gi;

export function sanitizePreviewHtml(html: string): string {
  if (!html) {
    return "";
  }

  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const withoutDangerousBlocks = withoutComments
    .replace(DANGEROUS_HTML_BLOCK_REGEX, "")
    .replace(DANGEROUS_HTML_SINGLE_TAG_REGEX, "");

  return withoutDangerousBlocks.replace(
    /<\/?([a-z0-9-]+)(\s[^<>]*?)?\s*\/?>/gi,
    (match, rawTagName: string, rawAttributes?: string) => {
      const tagName = rawTagName.toLowerCase();
      if (!SAFE_HTML_TAGS.has(tagName)) {
        return "";
      }

      if (match.startsWith("</")) {
        return `</${tagName}>`;
      }

      const attributes = sanitizePreviewAttributes(tagName, rawAttributes ?? "");
      const selfClosing = /\/\s*>$/.test(match) || tagName === "br" || tagName === "hr";
      return selfClosing
        ? `<${tagName}${attributes} />`
        : `<${tagName}${attributes}>`;
    }
  );
}

function sanitizePreviewAttributes(tagName: string, rawAttributes: string): string {
  const allowedAttributes = SAFE_HTML_TAG_ATTRIBUTES[tagName];
  if (!allowedAttributes) {
    return "";
  }

  const safeAttributes: string[] = [];
  let safeHref: string | null = null;
  let openInNewTab = false;
  let title: string | null = null;

  for (const match of rawAttributes.matchAll(
    /([^\s=<>"'`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  )) {
    const attributeName = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";

    if (attributeName.startsWith("on") || attributeName === "style") {
      continue;
    }

    if (!allowedAttributes.has(attributeName)) {
      continue;
    }

    if (attributeName === "href") {
      const nextHref = sanitizePreviewHref(value);
      if (nextHref) {
        safeHref = nextHref;
      }
      continue;
    }

    if (attributeName === "target") {
      openInNewTab = value === "_blank";
      continue;
    }

    if (attributeName === "title") {
      title = escapeHtmlAttribute(value);
      continue;
    }

    if (attributeName === "colspan" || attributeName === "rowspan") {
      if (/^[1-9]\d?$/.test(value)) {
        safeAttributes.push(` ${attributeName}="${value}"`);
      }
    }
  }

  if (safeHref) {
    safeAttributes.push(` href="${escapeHtmlAttribute(safeHref)}"`);
  }
  if (title) {
    safeAttributes.push(` title="${title}"`);
  }
  if (openInNewTab) {
    safeAttributes.push(' target="_blank" rel="noopener noreferrer"');
  }

  return safeAttributes.join("");
}

function sanitizePreviewHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("tel:") ||
    normalized.startsWith("/") ||
    normalized.startsWith("#")
  ) {
    return trimmed;
  }

  return null;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export { regenerateHtmlFromPlainText } from "@/lib/html-utils";

export function formatFileNote(clip: Clip): string {
  const size = formatBytes(clip.size_bytes || 0);
  if (!clip.local_only) {
    return size;
  }
  return clip.local_origin === "sender"
    ? `${size} • local only`
    : `${size} • direct transfer`;
}

export function resolveDecryptError(error: unknown): string {
  if (error instanceof WrongUnlockSecretError) {
    return "Wrong unlock secret";
  }
  if (error instanceof ClipCryptoError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Failed to decrypt clip";
}

export async function loadEncryptedFile(fileUrl: string | null): Promise<ArrayBuffer> {
  if (!fileUrl) {
    throw new Error("Failed to load encrypted file");
  }

  const response = await fetch(fileUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load encrypted file");
  }

  return response.arrayBuffer();
}

export async function downloadBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

let tickListeners = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;

function subscribeTick(cb: () => void) {
  tickListeners.add(cb);
  if (!tickInterval) {
    tickInterval = setInterval(() => {
      tickListeners.forEach((fn) => fn());
    }, 1000);
  }
  return () => {
    tickListeners.delete(cb);
    if (tickListeners.size === 0 && tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  };
}

function formatCountdown(expiresAt: string): string {
  const diff = parseUtcTimestamp(expiresAt) - Date.now();
  if (diff <= 0) {
    return "expired";
  }
  const h = Math.floor(diff / 3_600_000);
  if (h >= 8760) {
    return ""; // no expiry
  }
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function useCountdown(expiresAt: string): string {
  return useSyncExternalStore(
    subscribeTick,
    () => formatCountdown(expiresAt),
    () => "--:--:--"
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}
