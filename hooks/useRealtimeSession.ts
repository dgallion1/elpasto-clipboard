"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Clip, ClipZone } from "@/lib/clips";
import { buildApiUrl, buildSseUrl } from "@/lib/api";
import type { PeerSignalMessage } from "@/lib/realtime-session";

interface UseRealtimeSessionOptions {
  token: string;
  enabled?: boolean;
  onClipCreated: (clip: Clip) => void;
  onClipDeleted: (data: { id: number; zone: ClipZone }) => void;
  onClipsCleared: (data: { zone?: ClipZone }) => void;
  onSessionExpired: () => void;
  onPeerSignal: (message: PeerSignalMessage) => void;
  onTunnelAnnounce?: (data: { peerId: string; label?: string; port?: number; serverRelay?: boolean; prefix?: string }) => void;
  onTunnelClose?: (data: { peerId: string; serverRelay?: boolean }) => void;
}

type SignalSender = (message: PeerSignalMessage) => Promise<boolean>;

export function useRealtimeSession({
  token,
  enabled = true,
  onClipCreated,
  onClipDeleted,
  onClipsCleared,
  onSessionExpired,
  onPeerSignal,
  onTunnelAnnounce,
  onTunnelClose,
}: UseRealtimeSessionOptions) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const signalSenderRef = useRef<SignalSender>(async () => false);

  const [signalingReady, setSignalingReady] = useState(false);

  const onClipCreatedRef = useRef(onClipCreated);
  const onClipDeletedRef = useRef(onClipDeleted);
  const onClipsClearedRef = useRef(onClipsCleared);
  const onSessionExpiredRef = useRef(onSessionExpired);
  const onPeerSignalRef = useRef(onPeerSignal);
  const onTunnelAnnounceRef = useRef(onTunnelAnnounce);
  const onTunnelCloseRef = useRef(onTunnelClose);

  useEffect(() => {
    onClipCreatedRef.current = onClipCreated;
    onClipDeletedRef.current = onClipDeleted;
    onClipsClearedRef.current = onClipsCleared;
    onSessionExpiredRef.current = onSessionExpired;
    onPeerSignalRef.current = onPeerSignal;
    onTunnelAnnounceRef.current = onTunnelAnnounce;
    onTunnelCloseRef.current = onTunnelClose;
  });

  useEffect(() => {
    if (!enabled) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      signalSenderRef.current = async () => false;
      return;
    }

    const eventSource = new EventSource(
      buildSseUrl(`/api/sessions/${token}/events`)
    );
    eventSourceRef.current = eventSource;

    signalSenderRef.current = async (message) => {
      const response = await fetch(buildApiUrl(`/api/sessions/${token}/signal`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      return response.ok;
    };

    const handleOpen = () => {
      setSignalingReady(true);
    };
    const handleError = () => {
      setSignalingReady(false);
    };
    const handleClipCreated = (event: Event) => {
      const clip = parseEventData<Clip>(event);
      if (clip) {
        onClipCreatedRef.current(clip);
      }
    };

    const handleClipDeleted = (event: Event) => {
      const data = parseEventData<{ id: number; zone: ClipZone }>(event);
      if (data) {
        onClipDeletedRef.current(data);
      }
    };

    const handleClipsCleared = (event: Event) => {
      const data = parseEventData<{ zone?: ClipZone }>(event);
      if (data) {
        onClipsClearedRef.current(data);
      }
    };

    const handleSessionExpired = () => {
      onSessionExpiredRef.current();
      eventSource.close();
      setSignalingReady(false);
    };

    const handlePeerSignal = (event: Event) => {
      const message = parseEventData<PeerSignalMessage>(event);
      if (message) {
        onPeerSignalRef.current(message);
      }
    };

    const handleTunnelAnnounce = (event: Event) => {
      const data = parseEventData<{ peerId: string; label?: string; port?: number; serverRelay?: boolean; prefix?: string }>(event);
      if (data) onTunnelAnnounceRef.current?.(data);
    };
    const handleTunnelClose = (event: Event) => {
      const data = parseEventData<{ peerId: string; serverRelay?: boolean }>(event);
      if (data) onTunnelCloseRef.current?.(data);
    };

    eventSource.addEventListener("open", handleOpen);
    eventSource.addEventListener("error", handleError);
    eventSource.addEventListener("clip:created", handleClipCreated);
    eventSource.addEventListener("clip:deleted", handleClipDeleted);
    eventSource.addEventListener("clips:cleared", handleClipsCleared);
    eventSource.addEventListener("session:expired", handleSessionExpired);
    eventSource.addEventListener("peer:signal", handlePeerSignal);
    eventSource.addEventListener("tunnel:announce", handleTunnelAnnounce);
    eventSource.addEventListener("tunnel:close", handleTunnelClose);

    return () => {
      eventSource.removeEventListener("open", handleOpen);
      eventSource.removeEventListener("error", handleError);
      eventSource.removeEventListener("clip:created", handleClipCreated);
      eventSource.removeEventListener("clip:deleted", handleClipDeleted);
      eventSource.removeEventListener("clips:cleared", handleClipsCleared);
      eventSource.removeEventListener("session:expired", handleSessionExpired);
      eventSource.removeEventListener("peer:signal", handlePeerSignal);
      eventSource.removeEventListener("tunnel:announce", handleTunnelAnnounce);
      eventSource.removeEventListener("tunnel:close", handleTunnelClose);
      eventSource.close();
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
      }
      signalSenderRef.current = async () => false;
      setSignalingReady(false);
    };
  }, [enabled, token]);

  const sendPeerSignal = useCallback(async (message: PeerSignalMessage) => {
    return signalSenderRef.current(message);
  }, []);

  return {
    sendPeerSignal,
    signalingReady,
  };
}

function parseEventData<T>(event: Event): T | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    return null;
  }

  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}
