import type { Metadata } from "next";
import "./globals.css";
import { FrontendVersionWatcher } from "./FrontendVersionWatcher";
import { Analytics } from "./Analytics";

export const metadata: Metadata = {
  title: "elPasto — Shared Clipboard",
  description: "Paste on one device, copy from another. No accounts needed.",
};

const cfAnalyticsToken = process.env.NEXT_PUBLIC_CF_ANALYTICS_TOKEN ?? "";
const plausibleAnalyticsEnabled =
  process.env.NEXT_PUBLIC_PLAUSIBLE_ENABLED === "1";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 antialiased min-h-screen">
        <FrontendVersionWatcher />
        <Analytics
          cfAnalyticsToken={cfAnalyticsToken}
          plausibleEnabled={plausibleAnalyticsEnabled}
        />
        {children}
      </body>
    </html>
  );
}
