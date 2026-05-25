"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildApiUrl } from "@/lib/api";
import { HelpModal } from "@/components/HelpModal";
import { TokenInput } from "@/components/TokenInput";

export default function Home() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const createSession = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(buildApiUrl("/api/sessions"), { method: "POST" });
      if (!res.ok) throw new Error("Failed to create session");
      const data = await res.json();
      router.push(`/${data.token}`);
    } catch {
      setError("Could not create session. Try again.");
      setCreating(false);
    }
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="max-w-md w-full text-center space-y-8">
        <div className="space-y-3">
          <h1 className="text-5xl font-bold tracking-tight text-neutral-100">
            elPasto
          </h1>
          <p className="text-neutral-400 text-lg">
            Paste on one device, copy from another.
          </p>
        </div>

        <div className="space-y-4">
          <button
            onClick={createSession}
            disabled={creating}
            className="w-full px-6 py-3 text-lg font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 rounded-lg transition-colors text-white"
          >
            {creating ? "Creating..." : "New Session"}
          </button>
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-neutral-600">
            <div className="h-px flex-1 bg-neutral-800" />
            <span>or join existing</span>
            <div className="h-px flex-1 bg-neutral-800" />
          </div>
          <TokenInput />
        </div>

        <div className="text-sm text-neutral-500 space-y-1">
          <p>No accounts needed. Sessions persist until manually closed.</p>
          <p>Share the URL or token to move clips between devices.</p>
        </div>

        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="text-sm text-neutral-500 underline underline-offset-2 transition hover:text-neutral-300"
        >
          How it works &amp; why it&apos;s secure
        </button>
      </div>
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
}
