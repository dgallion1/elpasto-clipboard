import type { Clip } from "@/lib/clips";

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
}

export interface TunnelSummary {
  peerId: string;
  serverRelay: boolean;
  label?: string;
  port?: number;
}

export interface SessionData {
  token: string;
  createdAt: string;
  expiresAt: string;
  clips: { A: Clip[]; B: Clip[] };
  turnCredentials?: TurnCredentials;
  tunnels?: TunnelSummary[];
}

export const EMPTY_CLIPS: Clip[] = [];
