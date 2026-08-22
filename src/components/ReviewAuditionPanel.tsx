"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReviewBundleManifest } from "../lib/reviewLearning";
import {
  auditionTrimDbToVolume,
  resolveAuditionBookmarks,
  resolveAuditionLevelMatch,
  resolveAuditionTrackTime,
  type AuditionBookmarkKind,
} from "../lib/reviewAudition";
import styles from "./QcReportLab.module.css";

type AuditionTrackId = "source" | "winner" | "challenger";

type AuditionTrack = Readonly<{
  id: AuditionTrackId;
  blindLabel: "A" | "B" | "C";
  revealedLabel: string;
  url: string;
  durationSec: number;
  alignmentOffsetSec: number;
  speechKWeightedEnergyDb: number | null | undefined;
  integratedLoudnessDb: number | null | undefined;
}>;

type ReviewAuditionPanelProps = Readonly<{
  manifest: ReviewBundleManifest;
  sourceUrl: string;
  winnerUrl: string;
  challengerUrl: string | null;
}>;

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds - minutes * 60;
  return `${minutes}:${remainingSeconds.toFixed(1).padStart(4, "0")}`;
};

const formatTrim = (trimDb: number) =>
  `${trimDb > -0.005 ? "0.0" : trimDb.toFixed(1)} dB`;

const formatBookmarkKind = (kind: AuditionBookmarkKind) => {
  if (kind === "flattened") return "flattened event";
  if (kind === "up-spike" || kind === "body-up-spike") return "upward spike";
  return "downward spike";
};

export default function ReviewAuditionPanel({
  manifest,
  sourceUrl,
  winnerUrl,
  challengerUrl,
}: ReviewAuditionPanelProps) {
  const sourceAudioRef = useRef<HTMLAudioElement | null>(null);
  const winnerAudioRef = useRef<HTMLAudioElement | null>(null);
  const challengerAudioRef = useRef<HTMLAudioElement | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<AuditionTrackId>("source");
  const [isPlaying, setIsPlaying] = useState(false);
  const [sourceTimeSec, setSourceTimeSec] = useState(0);
  const [labelsRevealed, setLabelsRevealed] = useState(false);
  const [levelMatchEnabled, setLevelMatchEnabled] = useState(false);
  const [playbackIssue, setPlaybackIssue] = useState<string | null>(null);

  const winner = manifest.candidates.find((candidate) => candidate.role === "winner") ?? null;
  const challenger =
    manifest.candidates.find((candidate) => candidate.role === "challenger") ?? null;
  const sourceDurationSec = Math.max(0, manifest.source.durationSec || 0);

  const tracks = useMemo<readonly AuditionTrack[]>(() => {
    const nextTracks: AuditionTrack[] = [
      {
        id: "source",
        blindLabel: "A",
        revealedLabel: "Source",
        url: sourceUrl,
        durationSec: sourceDurationSec,
        alignmentOffsetSec: 0,
        speechKWeightedEnergyDb: manifest.source.qc?.speechKWeightedEnergyDb,
        integratedLoudnessDb: manifest.source.qc?.inputI,
      },
      {
        id: "winner",
        blindLabel: "B",
        revealedLabel: winner ? `Selected · ${winner.variantLabel}` : "Selected",
        url: winnerUrl,
        durationSec:
          winner?.sourceComparison.alignment.durationCandidateSec ?? sourceDurationSec,
        alignmentOffsetSec:
          winner?.sourceComparison.alignment.estimatedOffsetSec ?? 0,
        speechKWeightedEnergyDb: winner?.qc?.speechKWeightedEnergyDb,
        integratedLoudnessDb: winner?.qc?.inputI,
      },
    ];
    if (challengerUrl && challenger) {
      nextTracks.push({
        id: "challenger",
        blindLabel: "C",
        revealedLabel: `Challenger · ${challenger.variantLabel}`,
        url: challengerUrl,
        durationSec: challenger.sourceComparison.alignment.durationCandidateSec,
        alignmentOffsetSec: challenger.sourceComparison.alignment.estimatedOffsetSec,
        speechKWeightedEnergyDb: challenger.qc?.speechKWeightedEnergyDb,
        integratedLoudnessDb: challenger.qc?.inputI,
      });
    }
    return nextTracks;
  }, [challenger, challengerUrl, manifest.source.qc, sourceDurationSec, sourceUrl, winner, winnerUrl]);

  const levelMatch = useMemo(
    () =>
      resolveAuditionLevelMatch(
        tracks.map((track) => ({
          id: track.id,
          speechKWeightedEnergyDb: track.speechKWeightedEnergyDb,
          integratedLoudnessDb: track.integratedLoudnessDb,
        })),
      ),
    [tracks],
  );
  const trimByTrack = useMemo(
    () =>
      Object.fromEntries(levelMatch.tracks.map((track) => [track.id, track.trimDb])) as Record<
        AuditionTrackId,
        number
      >,
    [levelMatch.tracks],
  );
  const matchingActive = levelMatchEnabled && levelMatch.metric !== "unavailable";
  const bookmarks = useMemo(
    () =>
      resolveAuditionBookmarks(
        manifest.candidates.map((candidate) => ({
          trackId: candidate.role,
          voiceStability: candidate.sourceComparison.voiceStability,
        })),
      ),
    [manifest.candidates],
  );

  const getAudio = useCallback((trackId: AuditionTrackId) => {
    if (trackId === "source") return sourceAudioRef.current;
    if (trackId === "winner") return winnerAudioRef.current;
    return challengerAudioRef.current;
  }, []);

  const pauseAll = useCallback(() => {
    for (const track of tracks) getAudio(track.id)?.pause();
  }, [getAudio, tracks]);

  const seekAll = useCallback(
    (nextSourceTimeSec: number) => {
      const clampedSourceTime = Math.min(
        sourceDurationSec,
        Math.max(0, Number.isFinite(nextSourceTimeSec) ? nextSourceTimeSec : 0),
      );
      setSourceTimeSec(clampedSourceTime);
      for (const track of tracks) {
        const audio = getAudio(track.id);
        if (!audio) continue;
        audio.currentTime = resolveAuditionTrackTime(
          clampedSourceTime,
          track.alignmentOffsetSec,
          track.durationSec,
        );
      }
    },
    [getAudio, sourceDurationSec, tracks],
  );

  useEffect(() => {
    for (const track of tracks) {
      const audio = getAudio(track.id);
      if (!audio) continue;
      audio.muted = track.id !== activeTrackId;
      audio.volume = matchingActive
        ? auditionTrimDbToVolume(trimByTrack[track.id] ?? 0)
        : 1;
    }
  }, [activeTrackId, getAudio, matchingActive, tracks, trimByTrack]);

  useEffect(() => () => pauseAll(), [pauseAll]);

  const togglePlayback = async () => {
    if (isPlaying) {
      pauseAll();
      setIsPlaying(false);
      return;
    }

    setPlaybackIssue(null);
    seekAll(sourceTimeSec >= sourceDurationSec ? 0 : sourceTimeSec);
    const results = await Promise.allSettled(
      tracks.map(async (track) => {
        const audio = getAudio(track.id);
        if (!audio) throw new Error(`Track ${track.id} is unavailable.`);
        await audio.play();
      }),
    );
    const activeIndex = tracks.findIndex((track) => track.id === activeTrackId);
    if (activeIndex < 0 || results[activeIndex]?.status === "rejected") {
      pauseAll();
      setIsPlaying(false);
      setPlaybackIssue("Playback could not start. Try the play button again after the files finish loading.");
      return;
    }
    setIsPlaying(true);
  };

  const selectTrack = (trackId: AuditionTrackId) => {
    const nextTrack = tracks.find((track) => track.id === trackId);
    const nextAudio = nextTrack ? getAudio(nextTrack.id) : null;
    const sourceNow = sourceAudioRef.current?.currentTime ?? sourceTimeSec;
    for (const track of tracks) {
      const audio = getAudio(track.id);
      if (audio) audio.muted = true;
    }
    if (nextTrack && nextAudio) {
      nextAudio.currentTime = resolveAuditionTrackTime(
        sourceNow,
        nextTrack.alignmentOffsetSec,
        nextTrack.durationSec,
      );
      nextAudio.volume = matchingActive
        ? auditionTrimDbToVolume(trimByTrack[nextTrack.id] ?? 0)
        : 1;
      nextAudio.muted = false;
    }
    setActiveTrackId(trackId);
  };

  const levelMetricLabel =
    levelMatch.metric === "speech-k-weighted"
      ? "speech K-weighted energy"
      : levelMatch.metric === "integrated-loudness"
        ? "integrated loudness fallback"
        : "matching evidence unavailable";

  return (
    <div className={styles.auditionPanel}>
      <div className={styles.auditionHeader}>
        <div>
          <div className={styles.sectionTitle}>Shared audition</div>
          <div className={styles.muted}>
            Static attenuation only · {levelMetricLabel}
          </div>
        </div>
        <div className={styles.controls}>
          <button className={styles.buttonSecondary} type="button" onClick={() => void togglePlayback()}>
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button
            className={styles.buttonGhost}
            type="button"
            disabled={levelMatch.metric === "unavailable"}
            onClick={() => setLevelMatchEnabled((enabled) => !enabled)}
          >
            Match {matchingActive ? "on" : "off"}
          </button>
          <button
            className={styles.buttonGhost}
            type="button"
            onClick={() => setLabelsRevealed((revealed) => !revealed)}
          >
            {labelsRevealed ? "Hide labels" : "Reveal labels"}
          </button>
        </div>
      </div>

      <div className={styles.auditionTrackGrid} aria-label="Audition tracks">
        {tracks.map((track) => {
          const appliedTrimDb = matchingActive ? trimByTrack[track.id] ?? 0 : 0;
          const label = labelsRevealed
            ? `${track.blindLabel} · ${track.revealedLabel}`
            : track.blindLabel;
          return (
            <button
              className={`${styles.auditionTrackButton} ${
                activeTrackId === track.id ? styles.auditionTrackButtonActive : ""
              }`}
              type="button"
              key={track.id}
              onClick={() => selectTrack(track.id)}
              aria-pressed={activeTrackId === track.id}
              aria-label={labelsRevealed ? label : `Blind track ${track.blindLabel}`}
            >
              <strong>{label}</strong>
              <span>{formatTrim(appliedTrimDb)} applied</span>
            </button>
          );
        })}
      </div>

      <div className={styles.auditionTimeline}>
        <label htmlFor={`audition-${manifest.bundleId}`}>
          {formatTime(sourceTimeSec)} / {formatTime(sourceDurationSec)}
        </label>
        <input
          id={`audition-${manifest.bundleId}`}
          type="range"
          min="0"
          max={Math.max(0.01, sourceDurationSec)}
          step="0.01"
          value={Math.min(sourceTimeSec, Math.max(0.01, sourceDurationSec))}
          onChange={(event) => seekAll(Number(event.target.value))}
          aria-label="Shared audition position"
        />
      </div>

      {bookmarks.length > 0 && (
        <div>
          <div className={styles.sectionTitle}>Evidence bookmarks</div>
          <div className={styles.tagGrid}>
            {bookmarks.map((bookmark, index) => {
              const track = tracks.find((item) => item.id === bookmark.trackId);
              if (!track) return null;
              const identity = labelsRevealed
                ? `${track.blindLabel} · ${track.revealedLabel}`
                : track.blindLabel;
              return (
                <button
                  className={styles.tagButton}
                  type="button"
                  key={`${bookmark.trackId}-${bookmark.kind}-${bookmark.sourceTimeSec}-${index}`}
                  onClick={() => {
                    seekAll(bookmark.sourceTimeSec);
                    selectTrack(track.id);
                  }}
                >
                  {identity} · {formatBookmarkKind(bookmark.kind)} · {formatTime(bookmark.sourceTimeSec)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {playbackIssue && <div className={styles.errorText}>{playbackIssue}</div>}

      <audio
        ref={sourceAudioRef}
        preload="auto"
        src={sourceUrl}
        className={styles.hiddenAudio}
        onTimeUpdate={() => setSourceTimeSec(sourceAudioRef.current?.currentTime ?? 0)}
        onEnded={() => {
          pauseAll();
          setIsPlaying(false);
          setSourceTimeSec(sourceDurationSec);
        }}
      />
      <audio ref={winnerAudioRef} preload="auto" src={winnerUrl} className={styles.hiddenAudio} />
      {challengerUrl && (
        <audio
          ref={challengerAudioRef}
          preload="auto"
          src={challengerUrl}
          className={styles.hiddenAudio}
        />
      )}
    </div>
  );
}
