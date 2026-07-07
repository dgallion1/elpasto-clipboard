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

  useEffect(() => {
    let cancelled = false;
    void import("qrcode.react").then((module) => {
      if (!cancelled) setQRCodeSVG(() => module.QRCodeSVG);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
