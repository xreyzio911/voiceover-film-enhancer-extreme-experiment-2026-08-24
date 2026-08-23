export type ExtremeSourceReport = Readonly<{
  schemaVersion: 1;
  advisoryOnly: true;
  canBlockDelivery: false;
  canChangeGainDb: false;
  levelAuthority: "gainPlanner";
  modelSetId: string;
  source: Readonly<{
    sha256: string;
    durationMs: number;
    sampleRate: number;
    channels: number;
  }>;
  vad: Readonly<{
    frameMs: number;
    frames: readonly Readonly<{
      startMs: number;
      endMs: number;
      speechProbability: number;
    }>[];
  }>;
  metrics: Readonly<Record<string, Readonly<{
    value: number | null;
    available: boolean;
    higherIsBetter: boolean;
  }>>>;
  models: readonly Readonly<{
    id: string;
    version: string;
    revision: string;
    sha256: string;
  }>[];
}>;

export type ExtremeAnalysisOutcome =
  | Readonly<{ status: "succeeded"; report: ExtremeSourceReport }>
  | Readonly<{ status: "unavailable"; reason: string }>;

type AnalyzeSourceInput = Readonly<{
  source: Blob;
  contentType: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  chunkBytes?: number;
  maxPolls?: number;
}>;

const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_POLLS = 60;
const POLL_INTERVAL_MS = 1_000;
const MAX_REPORT_FRAMES = 216_000; // 36 minutes at 10 ms frames; protects the browser from hostile reports.

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isHex = (value: string, length: number) =>
  value.length === length && /^[0-9a-f]+$/.test(value);

const isPinnedRevision = (value: string) =>
  /^pypi:[0-9]+(?:\.[0-9A-Za-z]+){1,3}$/.test(value) || isHex(value, 40);

export const normalizeExtremeWorkerBaseUrl = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    const hostname = url.hostname.toLowerCase();
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && local) return url.origin;
    return null;
  } catch {
    return null;
  }
};

const freezeMetric = (value: unknown) => {
  const metric = value as { value?: unknown; available?: unknown; higherIsBetter?: unknown };
  if (!metric || typeof metric !== "object") return null;
  if (metric.value !== null && !isFiniteNumber(metric.value)) return null;
  if (typeof metric.available !== "boolean" || typeof metric.higherIsBetter !== "boolean") return null;
  return Object.freeze({
    value: metric.value,
    available: metric.available,
    higherIsBetter: metric.higherIsBetter,
  });
};

export const normalizeExtremeSourceReport = (value: unknown): ExtremeSourceReport | null => {
  const report = value as {
    schemaVersion?: unknown;
    advisoryOnly?: unknown;
    canBlockDelivery?: unknown;
    canChangeGainDb?: unknown;
    levelAuthority?: unknown;
    modelSetId?: unknown;
    source?: { sha256?: unknown; durationMs?: unknown; sampleRate?: unknown; channels?: unknown };
    vad?: { frameMs?: unknown; frames?: unknown };
    metrics?: unknown;
    models?: unknown;
  };
  if (!report || typeof report !== "object") return null;
  if (
    report.schemaVersion !== 1 ||
    report.advisoryOnly !== true ||
    report.canBlockDelivery !== false ||
    report.canChangeGainDb !== false ||
    report.levelAuthority !== "gainPlanner" ||
    typeof report.modelSetId !== "string" ||
    !report.modelSetId
  ) {
    return null;
  }
  const source = report.source;
  const sampleRate = source?.sampleRate;
  const channels = source?.channels;
  if (
    !source ||
    typeof source !== "object" ||
    typeof source.sha256 !== "string" ||
    !isHex(source.sha256, 64) ||
    !isFiniteNumber(source.durationMs)
  ) {
    return null;
  }
  if (
    !isFiniteNumber(sampleRate) ||
    !isFiniteNumber(channels) ||
    !Number.isInteger(sampleRate) ||
    !Number.isInteger(channels) ||
    source.durationMs < 0 ||
    sampleRate <= 0 ||
    channels <= 0
  ) return null;
  const vad = report.vad;
  if (
    !vad ||
    typeof vad !== "object" ||
    !isFiniteNumber(vad.frameMs) ||
    vad.frameMs <= 0 ||
    !Array.isArray(vad.frames) ||
    vad.frames.length > MAX_REPORT_FRAMES
  ) {
    return null;
  }
  let previousEnd = 0;
  const frames = [];
  for (const frame of vad.frames) {
    const candidate = frame as { startMs?: unknown; endMs?: unknown; speechProbability?: unknown };
    if (
      !isFiniteNumber(candidate.startMs) ||
      !isFiniteNumber(candidate.endMs) ||
      !isFiniteNumber(candidate.speechProbability) ||
      candidate.startMs < 0 ||
      candidate.endMs <= candidate.startMs ||
      candidate.speechProbability < 0 ||
      candidate.speechProbability > 1 ||
      candidate.startMs < previousEnd
    ) {
      return null;
    }
    previousEnd = candidate.endMs;
    frames.push(Object.freeze({
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      speechProbability: candidate.speechProbability,
    }));
  }
  if (!report.metrics || typeof report.metrics !== "object" || Array.isArray(report.metrics)) return null;
  const metrics: Record<string, ReturnType<typeof freezeMetric>> = {};
  for (const [key, metric] of Object.entries(report.metrics)) {
    if (!key || key.length > 80) return null;
    const cleanMetric = freezeMetric(metric);
    if (!cleanMetric) return null;
    metrics[key] = cleanMetric;
  }
  if (!Array.isArray(report.models) || report.models.length > 50) return null;
  const models = [];
  for (const model of report.models) {
    const candidate = model as { id?: unknown; version?: unknown; revision?: unknown; sha256?: unknown };
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.version !== "string" ||
      typeof candidate.revision !== "string" ||
      typeof candidate.sha256 !== "string" ||
      !candidate.id ||
      !candidate.version ||
      !isPinnedRevision(candidate.revision) ||
      !isHex(candidate.sha256, 64)
    ) {
      return null;
    }
    models.push(Object.freeze({
      id: candidate.id,
      version: candidate.version,
      revision: candidate.revision,
      sha256: candidate.sha256,
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    advisoryOnly: true,
    canBlockDelivery: false,
    canChangeGainDb: false,
    levelAuthority: "gainPlanner",
    modelSetId: report.modelSetId,
    source: Object.freeze({
      sha256: source.sha256,
      durationMs: source.durationMs,
      sampleRate,
      channels,
    }),
    vad: Object.freeze({ frameMs: vad.frameMs, frames: Object.freeze(frames) }),
    metrics: Object.freeze(metrics as Record<string, NonNullable<ReturnType<typeof freezeMetric>>>),
    models: Object.freeze(models),
  });
};

const postJson = async (fetchImpl: typeof fetch, url: string, body: unknown, headers: HeadersInit = {}) =>
  fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const unavailable = (reason: string): ExtremeAnalysisOutcome => Object.freeze({ status: "unavailable", reason });

export const analyzeSourceWithExtremeWorker = async ({
  source,
  contentType,
  idempotencyKey,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  chunkBytes = DEFAULT_CHUNK_BYTES,
  maxPolls = DEFAULT_MAX_POLLS,
}: AnalyzeSourceInput): Promise<ExtremeAnalysisOutcome> => {
  try {
    const ticketResponse = await postJson(fetchImpl, "/api/extreme-ml/ticket", {
      sizeBytes: source.size,
      contentType,
      idempotencyKey,
      scope: "source_analysis",
    });
    if (!ticketResponse.ok) return unavailable("ticket-unavailable");
    const ticket = (await ticketResponse.json()) as {
      workerBaseUrl?: unknown;
      ticket?: unknown;
    };
    const workerBaseUrl = normalizeExtremeWorkerBaseUrl(
      typeof ticket.workerBaseUrl === "string" ? ticket.workerBaseUrl : "",
    );
    if (!workerBaseUrl || typeof ticket.ticket !== "string" || !ticket.ticket) {
      return unavailable("ticket-unavailable");
    }

    const jobResponse = await postJson(
      fetchImpl,
      `${workerBaseUrl}/v1/jobs`,
      { idempotencyKey, sizeBytes: source.size, contentType, scope: "source_analysis" },
      { Authorization: `Bearer ${ticket.ticket}` },
    );
    if (!jobResponse.ok) return unavailable("worker-job-unavailable");
    const job = (await jobResponse.json()) as {
      jobId?: unknown;
      accessToken?: unknown;
      uploadOffset?: unknown;
      maxChunkBytes?: unknown;
    };
    if (typeof job.jobId !== "string" || typeof job.accessToken !== "string") {
      return unavailable("worker-job-unavailable");
    }
    const effectiveChunkBytes = Math.max(
      1,
      Math.min(
        Math.floor(chunkBytes),
        isFiniteNumber(job.maxChunkBytes) && job.maxChunkBytes > 0 ? Math.floor(job.maxChunkBytes) : chunkBytes,
      ),
    );
    let offset = isFiniteNumber(job.uploadOffset) && job.uploadOffset >= 0 ? Math.floor(job.uploadOffset) : 0;
    while (offset < source.size) {
      const chunk = source.slice(offset, Math.min(source.size, offset + effectiveChunkBytes), contentType);
      const uploadResponse = await fetchImpl(`${workerBaseUrl}/v1/jobs/${encodeURIComponent(job.jobId)}/input`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${job.accessToken}`,
          "Content-Type": contentType,
          "Upload-Offset": String(offset),
        },
        body: chunk,
      });
      if (!uploadResponse.ok) return unavailable("upload-unavailable");
      const nextOffset = Number(uploadResponse.headers.get("Upload-Offset"));
      if (!Number.isInteger(nextOffset) || nextOffset <= offset || nextOffset > source.size) {
        return unavailable("upload-offset-invalid");
      }
      offset = nextOffset;
    }
    const completeResponse = await postJson(
      fetchImpl,
      `${workerBaseUrl}/v1/jobs/${encodeURIComponent(job.jobId)}/input/complete`,
      {},
      { Authorization: `Bearer ${job.accessToken}` },
    );
    if (!completeResponse.ok) return unavailable("upload-complete-unavailable");

    for (let poll = 0; poll < maxPolls; poll += 1) {
      const statusResponse = await fetchImpl(`${workerBaseUrl}/v1/jobs/${encodeURIComponent(job.jobId)}`, {
        headers: { Authorization: `Bearer ${job.accessToken}` },
      });
      if (!statusResponse.ok) return unavailable("status-unavailable");
      const status = (await statusResponse.json()) as { state?: unknown };
      if (status.state === "failed" || status.state === "cancelled") return unavailable("worker-failed");
      if (status.state === "succeeded") {
        const reportResponse = await fetchImpl(`${workerBaseUrl}/v1/jobs/${encodeURIComponent(job.jobId)}/report`, {
          headers: { Authorization: `Bearer ${job.accessToken}` },
        });
        if (!reportResponse.ok) return unavailable("report-unavailable");
        const report = normalizeExtremeSourceReport(await reportResponse.json());
        return report ? Object.freeze({ status: "succeeded", report }) : unavailable("report-invalid");
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return unavailable("poll-timeout");
  } catch {
    return unavailable("worker-unavailable");
  }
};
