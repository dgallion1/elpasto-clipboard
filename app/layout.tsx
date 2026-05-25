import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { FrontendVersionWatcher } from "./FrontendVersionWatcher";

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
        {cfAnalyticsToken ? (
          <Script
            id="cf-web-analytics"
            src="https://static.cloudflareinsights.com/beacon.min.js"
            strategy="afterInteractive"
            data-cf-beacon={JSON.stringify({ token: cfAnalyticsToken })}
          />
        ) : null}
        {plausibleAnalyticsEnabled ? (
          <>
            <Script
              id="plausible-init"
              src="/pl/init.js"
              strategy="beforeInteractive"
            />
            <Script
              id="plausible-script"
              src="/pl/script.js"
              strategy="afterInteractive"
            />
          </>
        ) : null}
        {children}
      </body>
    </html>
  );
}
