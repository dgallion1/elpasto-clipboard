import type { Clip, ClipZone } from "@/lib/clips";
import type { SessionData } from "./session-page-types";
import { EMPTY_CLIPS } from "./session-page-types";

export type ClipGroups = Record<string, Clip[]>;

export function clipsFromSession(data: SessionData): ClipGroups {
  const groups: ClipGroups = {};
  const clipsByZone = data.clips as Record<string, Clip[]> | undefined;
  for (const clips of Object.values(clipsByZone ?? {})) {
    for (const clip of clips) {
      (groups[clip.zone] ??= []).push(clip);
    }
  }
  return groups;
}

export function allGroupedClips(groups: ClipGroups): Clip[] {
  return Object.values(groups).flat();
}

export function addClipToGroups(groups: ClipGroups, clip: Clip): ClipGroups {
  const zoneClips = groups[clip.zone] ?? EMPTY_CLIPS;
  if (zoneClips.some((current) => current.id === clip.id)) {
    return groups;
  }
  return { ...groups, [clip.zone]: [clip, ...zoneClips] };
}

export function removeClipFromGroups(
  groups: ClipGroups,
  clipId: number,
  zone?: ClipZone,
): ClipGroups {
  if (zone) {
    return {
      ...groups,
      [zone]: (groups[zone] ?? EMPTY_CLIPS).filter((clip) => clip.id !== clipId),
    };
  }
  const next: ClipGroups = {};
  for (const [threadId, clips] of Object.entries(groups)) {
    next[threadId] = clips.filter((clip) => clip.id !== clipId);
  }
  return next;
}

export function clearClipGroup(groups: ClipGroups, zone?: ClipZone): ClipGroups {
  if (!zone) {
    return {};
  }
  return { ...groups, [zone]: [] };
}

export function clipZonesFromGroups(...groups: ClipGroups[]): ClipZone[] {
  const zones = new Set<ClipZone>();
  for (const group of groups) {
    for (const clip of allGroupedClips(group)) {
      zones.add(clip.zone);
    }
  }
  return Array.from(zones);
}
