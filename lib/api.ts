"use client";

const RAW_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ?? "";

/**
 * In dev mode, the Go backend port for direct connections (bypassing
 * Next.js proxy).  Used for SSE which requires unbuffered streaming.
 */
const GO_BACKEND_PORT = process.env.NEXT_PUBLIC_GO_BACKEND_PORT?.trim() ?? "";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeApiPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function buildApiUrl(path: string): string {
  const normalizedPath = normalizeApiPath(path);
  const baseUrl = normalizeBaseUrl(RAW_API_BASE_URL);

  if (!baseUrl) {
    return normalizedPath;
  }

  if (baseUrl.endsWith("/api") && normalizedPath.startsWith("/api/")) {
    return `${baseUrl}${normalizedPath.slice(4)}`;
  }

  if (baseUrl.endsWith("/api") && normalizedPath === "/api") {
    return baseUrl;
  }

  return `${baseUrl}${normalizedPath}`;
}

/**
 * Build a URL for SSE endpoints that bypasses the Next.js dev proxy.
 * Next.js rewrites buffer responses, which breaks Server-Sent Events.
 * In production (single Go binary), this returns the same as buildApiUrl.
 */
export function buildSseUrl(path: string): string {
  if (GO_BACKEND_PORT) {
    const normalizedPath = normalizeApiPath(path);
    return `http://localhost:${GO_BACKEND_PORT}${normalizedPath}`;
  }
  return buildApiUrl(path);
}
