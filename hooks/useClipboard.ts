"use client";

import { useState, useEffect } from "react";

interface ClipboardCapabilities {
  canCopyRich: boolean;
  canCopyImage: boolean;
}

export function useClipboardCapabilities(): ClipboardCapabilities {
  const [caps, setCaps] = useState<ClipboardCapabilities>({
    canCopyRich: false,
    canCopyImage: false,
  });

  useEffect(() => {
    async function detect() {
      let canCopyRich = false;
      let canCopyImage = false;

      try {
        if (typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined") {
          canCopyRich = true;
          try {
            // Test if image/png is accepted
            new ClipboardItem({
              "image/png": new Blob([new Uint8Array(0)], { type: "image/png" }),
            });
            canCopyImage = true;
          } catch {
            // image copy not supported
          }
        }
      } catch {
        // clipboard API not available
      }

      setCaps({ canCopyRich, canCopyImage });
    }
    detect();
  }, []);

  return caps;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copyHtml(html: string, plainText: string): Promise<"rich" | "plain" | false> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      return "rich";
    }
  } catch {
    // Fall through to plain text
  }

  try {
    await navigator.clipboard.writeText(plainText);
    return "plain";
  } catch {
    return false;
  }
}

export async function copyImageFromUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return copyImageBlob(blob);
  } catch {
    return false;
  }
}

export async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    const pngBlob = blob.type === "image/png" ? blob : await convertToPng(blob);
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
    return true;
  } catch {
    return false;
  }
}

function convertToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        return reject(new Error("No canvas context"));
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((result) => {
        URL.revokeObjectURL(objectUrl);
        if (result) resolve(result);
        else reject(new Error("toBlob failed"));
      }, "image/png");
    };
    img.onerror = (error) => {
      URL.revokeObjectURL(objectUrl);
      reject(error);
    };
    img.src = objectUrl;
  });
}
