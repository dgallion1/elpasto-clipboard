"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { shouldLoadAnalytics } from "@/lib/analytics-routing";

interface AnalyticsProps {
  cfAnalyticsToken: string;
  plausibleEnabled: boolean;
}

// Security (M2): only mount third-party analytics on routes that carry no
// secrets. Session/tunnel routes put the capability token in the URL path and
// /stats puts the dashboard key in the query — the beacons would report those
// to the analytics provider, so they are never loaded there.
export function Analytics({ cfAnalyticsToken, plausibleEnabled }: AnalyticsProps) {
  const pathname = usePathname();

  if (!shouldLoadAnalytics(pathname)) {
    return null;
  }

  return (
    <>
      {cfAnalyticsToken ? (
        <Script
          id="cf-web-analytics"
          src="https://static.cloudflareinsights.com/beacon.min.js"
          strategy="afterInteractive"
          data-cf-beacon={JSON.stringify({ token: cfAnalyticsToken })}
        />
      ) : null}
      {plausibleEnabled ? (
        <>
          <Script id="plausible-init" src="/pl/init.js" strategy="beforeInteractive" />
          <Script id="plausible-script" src="/pl/script.js" strategy="afterInteractive" />
        </>
      ) : null}
    </>
  );
}
