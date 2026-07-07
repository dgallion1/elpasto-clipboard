"use client";

import { useEffect, useState } from "react";

interface QRCodeProps {
  value: string;
  size?: number;
}

type QRCodeSVGComponent = React.ComponentType<{
  value: string;
  size: number;
  level: "L" | "M" | "Q" | "H";
  includeMargin: boolean;
  bgColor: string;
  fgColor: string;
}>;

export function QRCode({ value, size = 176 }: QRCodeProps) {
  const [QRCodeSVG, setQRCodeSVG] = useState<null | QRCodeSVGComponent>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("qrcode.react")
      .then((module) => {
        if (!cancelled) setQRCodeSVG(() => module.QRCodeSVG);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <div
        role="alert"
        className="flex items-center justify-center rounded bg-neutral-900 px-3 text-center text-xs text-neutral-500"
        style={{ width: size, height: size }}
      >
        QR unavailable — use the URL or token instead
      </div>
    );
  }

  if (!QRCodeSVG) {
    return (
      <div
        aria-label="Loading QR code"
        className="rounded bg-neutral-900"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <QRCodeSVG value={value} size={size} level="M" includeMargin={true} bgColor="#0a0a0a" fgColor="#e5e5e5" />
  );
}
