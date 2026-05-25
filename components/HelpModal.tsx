"use client";

import { useCallback, useRef, useState } from "react";

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

function Section({
  title,
  icon,
  children,
  technical,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
  technical?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-base font-semibold text-neutral-100">
        <span className="text-lg">{icon}</span>
        {title}
      </h3>
      <div className="text-sm leading-relaxed text-neutral-300">{children}</div>
      {technical && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-xs text-neutral-500 transition hover:text-neutral-300"
          >
            {expanded ? "Hide technical details" : "Technical details"}
          </button>
          {expanded && (
            <div className="mt-2 rounded-lg border border-neutral-800 bg-neutral-950/50 p-3 text-xs leading-relaxed text-neutral-500">
              {technical}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HelpModal({ open, onClose }: HelpModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="How elPasto works"
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl"
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold text-neutral-100">
            How elPasto works
          </h2>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="rounded-md p-1 text-neutral-500 transition hover:text-neutral-200"
            aria-label="Close"
          >
            &#x2715;
          </button>
        </div>

        <div className="space-y-6">
          <Section title="What is elPasto?" icon="&#x1F4CB;">
            <p>
              A shared clipboard between devices. Paste on one, copy from
              another. No accounts, no installs &mdash; just a URL or token.
              Sessions persist until manually closed.
            </p>
          </Section>

          <Section
            title="How it works"
            icon="&#x1F504;"
            technical={
              <ul className="list-inside list-disc space-y-1">
                <li>
                  Sessions are identified by a 5-word token (~55 bits of
                  entropy)
                </li>
                <li>
                  The server creates sessions and relays signaling only
                  &mdash; it never sees your data in any form
                </li>
                <li>
                  Server-Sent Events notify your browser when peers join or
                  leave
                </li>
                <li>
                  All clip content (text, HTML, images, files) transfers
                  directly between browsers via WebRTC data channels
                </li>
                <li>
                  Clips are stored in your browser (IndexedDB), not on the
                  server
                </li>
              </ul>
            }
          >
            <ol className="list-inside list-decimal space-y-1">
              <li>
                <strong className="text-neutral-300">Create a session</strong>{" "}
                &mdash; you get a unique URL
              </li>
              <li>
                <strong className="text-neutral-300">
                  Share the URL or token
                </strong>{" "}
                &mdash; open the same session on another device
              </li>
              <li>
                <strong className="text-neutral-300">
                  Paste on either device
                </strong>{" "}
                &mdash; text, images, and files transfer directly between your
                browsers
              </li>
            </ol>
          </Section>

          <Section
            title="Security"
            icon="&#x1F512;"
            technical={
              <div className="space-y-3">
                <p className="font-medium text-neutral-400">
                  Two layers of encryption protect your data:
                </p>
                <div className="space-y-2">
                  <div>
                    <p className="font-medium text-neutral-400">
                      Layer 1 &mdash; Transport (always on)
                    </p>
                    <ul className="mt-1 list-inside list-disc space-y-0.5">
                      <li>WebRTC data channels use DTLS for browser-to-browser transfer</li>
                      <li>Data never passes through the server &mdash; direct peer-to-peer</li>
                      <li>Protects against network eavesdropping</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium text-neutral-400">
                      Layer 2 &mdash; End-to-end encryption (when secret is set)
                    </p>
                    <ul className="mt-1 list-inside list-disc space-y-0.5">
                      <li>PBKDF2-SHA256 with 210,000 iterations derives a 256-bit key from your secret</li>
                      <li>AES-GCM encrypts each clip with a unique random salt and IV before it leaves your browser</li>
                      <li>Ciphertext only is sent over the wire and stored in the browser &mdash; plaintext never leaves memory</li>
                      <li>Decryption happens only when the receiving browser enters the same secret</li>
                    </ul>
                  </div>
                </div>
                <div>
                  <p className="font-medium text-neutral-400">
                    What the server sees
                  </p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    <li>Session metadata (token, creation time, zone labels) &mdash; nothing else</li>
                    <li>Signaling messages to help browsers find each other &mdash; no clip content</li>
                    <li>Zero knowledge: not even encrypted versions of your clips touch the server</li>
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-neutral-400">
                    Where your data lives
                  </p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    <li>Clip content (text, images, files): browser only (IndexedDB)</li>
                    <li>Encryption secret: browser tab memory only (sessionStorage) &mdash; never persisted to disk</li>
                    <li>With a secret set: IndexedDB stores ciphertext, not plaintext</li>
                    <li>Without a secret: IndexedDB stores plaintext &mdash; still never sent to the server</li>
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-neutral-400">
                    Encryption modes
                  </p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    <li><strong>Normal</strong> &mdash; secret stored in browser tab memory (sessionStorage). Cleared when the tab closes.</li>
                    <li><strong>Paranoid</strong> &mdash; passphrase is discarded after deriving an encryption key stored in IndexedDB. The key persists across reloads but the raw passphrase is never stored.</li>
                    <li>The stored key is <em>non-extractable</em>: the browser can use it to encrypt and decrypt, but no JavaScript &mdash; including extensions inspecting IndexedDB &mdash; can read the raw key bytes. Calling <code className="text-neutral-400">exportKey()</code> on it throws an error.</li>
                    <li><strong>Paranoid</strong> only decrypts clips created in paranoid mode (v2 / HKDF-SHA256). Legacy v1 clips require a raw passphrase and are not supported in paranoid mode.</li>
                  </ul>
                </div>
              </div>
            }
          >
            <p className="mb-2">
              The server{" "}
              <strong className="text-neutral-300">
                never sees your data in any form
              </strong>
              . All clips transfer directly between browsers over encrypted
              WebRTC connections.
            </p>
            <p>
              For an extra layer, click{" "}
              <strong className="text-neutral-300">Set Secret</strong> to add
              AES-256-GCM end-to-end encryption. Each clip is encrypted with a
              unique key before it leaves your browser &mdash; only someone with
              the same secret can decrypt it. The background turns green when a
              secret is active.
            </p>
          </Section>

          <Section
            title="Direct peer transfer"
            icon="&#x21C4;"
            technical={
              <ul className="list-inside list-disc space-y-1">
                <li>
                  WebRTC data channels with DTLS encryption for the P2P
                  connection itself
                </li>
                <li>
                  16 KiB chunked transfer with backpressure to handle large
                  files
                </li>
                <li>
                  Perfect negotiation pattern with polite/impolite roles for
                  reliable connections
                </li>
                <li>
                  File data is cached in your browser (IndexedDB) &mdash;
                  survives page refresh and supports later direct re-sends to
                  connected peers
                </li>
              </ul>
            }
          >
            <p>
              All clips transfer{" "}
              <strong className="text-neutral-300">
                directly between browsers
              </strong>{" "}
              over WebRTC. Peers that join later request clips from connected
              peers. You&apos;ll see a peer count badge when a direct connection
              is active. Clips are replicated across all peers and persist until
              deleted or all browser windows are closed by all peers.
            </p>
          </Section>

          <Section title="Good to know" icon="&#x26A0;">
            <ul className="list-inside list-disc space-y-1">
              <li>
                Anyone with the session URL or token has full access &mdash;
                treat it like a credential
              </li>
              <li>
                Share session links only with people or devices you trust
              </li>
              <li>
                Expired or unknown session links show the same unavailable state
              </li>
              <li>
                <strong>Delete</strong> removes a clip everywhere &mdash; all
                peers lose it permanently
              </li>
              <li>
                <strong>Clear</strong> only clears the current view; reloading
                the page can bring clips back
              </li>
              <li>
                Closing all browser tabs in a session loses clip data &mdash;
                clips live in the browser, not on the server
              </li>
              <li>
                This is for quick sharing, not long-term storage
              </li>
            </ul>
          </Section>
        </div>

        <div className="mt-6 border-t border-neutral-800 pt-4 text-center">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-200 transition hover:bg-neutral-700"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
