import { useCallback, useEffect, useRef } from "react";

const ORIGINAL_HREF = "/icon.svg";

// Clipboard SVG with a red notification dot in the top-right corner
const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect x="6" y="4" width="20" height="26" rx="3" fill="#1e3a5f" stroke="#60a5fa" stroke-width="1.5"/>
  <rect x="11" y="2" width="10" height="5" rx="2" fill="#3b82f6"/>
  <rect x="10" y="12" width="12" height="2" rx="1" fill="#93c5fd"/>
  <rect x="10" y="17" width="9" height="2" rx="1" fill="#60a5fa"/>
  <rect x="10" y="22" width="11" height="2" rx="1" fill="#3b82f6" opacity="0.7"/>
  <circle cx="26" cy="6" r="5" fill="#ef4444"/>
</svg>`;

const BADGE_HREF =
  "data:image/svg+xml," + encodeURIComponent(BADGE_SVG);

function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}

/**
 * Shows a red badge on the favicon when a new clip arrives while the tab
 * is in the background. Clears the badge when the tab becomes visible.
 *
 * Returns `notifyNewClip` — call it whenever a remote clip arrives.
 */
export function useFaviconBadge() {
  const hasBadgeRef = useRef(false);

  // Clear badge when tab becomes visible
  useEffect(() => {
    function onVisibilityChange() {
      if (!document.hidden && hasBadgeRef.current) {
        hasBadgeRef.current = false;
        setFavicon(ORIGINAL_HREF);
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Restore original on unmount
      if (hasBadgeRef.current) {
        hasBadgeRef.current = false;
        setFavicon(ORIGINAL_HREF);
      }
    };
  }, []);

  const notifyNewClip = useCallback(() => {
    if (document.hidden && !hasBadgeRef.current) {
      hasBadgeRef.current = true;
      setFavicon(BADGE_HREF);
    }
  }, []);

  return notifyNewClip;
}
