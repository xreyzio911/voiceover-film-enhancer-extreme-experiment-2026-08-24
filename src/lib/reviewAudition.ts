export type AuditionLevelMetric =
  | "speech-k-weighted"
  | "integrated-loudness"
  | "unavailable";

export type AuditionLevelTrack = Readonly<{
  id: string;
  speechKWeightedEnergyDb?: number | null;
  integratedLoudnessDb?: number | null;
}>;

export type AuditionLevelMatchPlan = Readonly<{
  metric: AuditionLevelMetric;
  targetDb: number | null;
  tracks: readonly Readonly<{ id: string; trimDb: number }>[];
}>;

export type AuditionBookmarkKind =
  | "up-spike"
  | "down-spike"
  | "body-up-spike"
  | "body-down-spike"
  | "flattened";

export type AuditionBookmark = Readonly<{
  trackId: string;
  sourceTimeSec: number;
  kind: AuditionBookmarkKind;
  severityDb: number;
}>;

const MAX_AUDITION_BOOKMARKS = 12;
const BOOKMARK_DEDUPLICATION_SECONDS = 0.08;

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const freezeUnavailableLevelMatch = (tracks: readonly AuditionLevelTrack[]) =>
  Object.freeze({
    metric: "unavailable" as const,
    targetDb: null,
    tracks: Object.freeze(
      tracks.map((track) => Object.freeze({ id: track.id, trimDb: 0 })),
    ),
  });

/**
 * Resolve one complete loudness lane across every audition track. Matching is
 * attenuation-only so the browser player cannot create a new peak or clip.
 */
export const resolveAuditionLevelMatch = (
  tracks: readonly AuditionLevelTrack[],
): AuditionLevelMatchPlan => {
  if (tracks.length === 0) return freezeUnavailableLevelMatch(tracks);

  const speechLevels = tracks.map((track) => track.speechKWeightedEnergyDb);
  const integratedLevels = tracks.map((track) => track.integratedLoudnessDb);
  const hasSpeechLane = speechLevels.every(finiteNumber);
  const hasIntegratedLane = integratedLevels.every(finiteNumber);
  const metric: AuditionLevelMetric = hasSpeechLane
    ? "speech-k-weighted"
    : hasIntegratedLane
      ? "integrated-loudness"
      : "unavailable";
  if (metric === "unavailable") return freezeUnavailableLevelMatch(tracks);

  const levels = (hasSpeechLane ? speechLevels : integratedLevels) as number[];
  const targetDb = Math.min(...levels);
  return Object.freeze({
    metric,
    targetDb,
    tracks: Object.freeze(
      tracks.map((track, index) =>
        Object.freeze({
          id: track.id,
          trimDb: Math.min(0, targetDb - levels[index]),
        }),
      ),
    ),
  });
};

export const auditionTrimDbToVolume = (trimDb: number) =>
  finiteNumber(trimDb) ? Math.min(1, Math.max(0, 10 ** (Math.min(0, trimDb) / 20))) : 1;

export const resolveAuditionTrackTime = (
  sourceTimeSec: number,
  alignmentOffsetSec: number,
  durationSec: number,
) => {
  const safeSourceTime = finiteNumber(sourceTimeSec) ? sourceTimeSec : 0;
  const safeOffset = finiteNumber(alignmentOffsetSec) ? alignmentOffsetSec : 0;
  const safeDuration = finiteNumber(durationSec) && durationSec > 0 ? durationSec : 0;
  return Math.min(safeDuration, Math.max(0, safeSourceTime + safeOffset));
};

type UnknownRecord = Record<string, unknown>;

const recordValue = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" ? (value as UnknownRecord) : null;

const nestedValue = (root: unknown, ...keys: string[]) => {
  let value: unknown = root;
  for (const key of keys) {
    const record = recordValue(value);
    if (!record) return undefined;
    value = record[key];
  }
  return value;
};

const eventArray = (value: unknown) => (Array.isArray(value) ? value : []);

const pushSpikeBookmarks = (
  target: AuditionBookmark[],
  trackId: string,
  kind: AuditionBookmarkKind,
  events: unknown,
) => {
  for (const event of eventArray(events)) {
    const record = recordValue(event);
    const sourceTimeSec = record?.centerSec;
    const severityDb = record?.peakAddedContrastDb;
    if (!finiteNumber(sourceTimeSec) || sourceTimeSec < 0 || !finiteNumber(severityDb)) continue;
    target.push({ trackId, sourceTimeSec, kind, severityDb });
  }
};

/**
 * Flatten advisory voice-stability events into source-timeline seek points.
 * Legacy or incomplete reports are ignored; no bookmark affects delivery.
 */
export const resolveAuditionBookmarks = (
  candidates: readonly Readonly<{ trackId: string; voiceStability?: unknown }>[],
): readonly AuditionBookmark[] => {
  const collected: AuditionBookmark[] = [];
  for (const candidate of candidates) {
    const report = nestedValue(candidate.voiceStability, "report");
    pushSpikeBookmarks(
      collected,
      candidate.trackId,
      "up-spike",
      nestedValue(report, "spikes", "up", "topEvents"),
    );
    pushSpikeBookmarks(
      collected,
      candidate.trackId,
      "down-spike",
      nestedValue(report, "spikes", "down", "topEvents"),
    );
    pushSpikeBookmarks(
      collected,
      candidate.trackId,
      "body-up-spike",
      nestedValue(report, "bodySpikes", "up", "topEvents"),
    );
    pushSpikeBookmarks(
      collected,
      candidate.trackId,
      "body-down-spike",
      nestedValue(report, "bodySpikes", "down", "topEvents"),
    );
    for (const event of eventArray(
      nestedValue(report, "expressiveRetention", "topFlattenedEvents"),
    )) {
      const record = recordValue(event);
      const sourceTimeSec = record?.centerSec;
      const severityDb = record?.contrastLossDb;
      if (!finiteNumber(sourceTimeSec) || sourceTimeSec < 0 || !finiteNumber(severityDb)) continue;
      collected.push({
        trackId: candidate.trackId,
        sourceTimeSec,
        kind: "flattened",
        severityDb,
      });
    }
  }

  const ordered = [...collected].sort(
    (left, right) =>
      left.sourceTimeSec - right.sourceTimeSec ||
      right.severityDb - left.severityDb ||
      left.trackId.localeCompare(right.trackId) ||
      left.kind.localeCompare(right.kind),
  );
  const deduplicated: AuditionBookmark[] = [];
  for (const bookmark of ordered) {
    const duplicateIndex = deduplicated.findIndex(
      (existing) =>
        existing.trackId === bookmark.trackId &&
        Math.abs(existing.sourceTimeSec - bookmark.sourceTimeSec) <=
          BOOKMARK_DEDUPLICATION_SECONDS,
    );
    if (duplicateIndex < 0) {
      deduplicated.push(bookmark);
    } else if (bookmark.severityDb > deduplicated[duplicateIndex].severityDb) {
      deduplicated[duplicateIndex] = bookmark;
    }
  }

  return Object.freeze(
    deduplicated
      .sort(
        (left, right) =>
          left.sourceTimeSec - right.sourceTimeSec ||
          left.trackId.localeCompare(right.trackId),
      )
      .slice(0, MAX_AUDITION_BOOKMARKS)
      .map((bookmark) => Object.freeze({ ...bookmark })),
  );
};
