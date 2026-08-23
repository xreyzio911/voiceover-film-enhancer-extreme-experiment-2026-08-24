export type ExtremeWorkerUploadFile = Readonly<{
  originalName: string;
  sizeBytes: number;
  mimeType?: string;
}>;

export type ExtremeWorkerUploadValidation = Readonly<
  | {
      ok: true;
      totalBytes: number;
      files: readonly Readonly<{
        originalName: string;
        safeName: string;
        sizeBytes: number;
      }>[];
    }
  | {
      ok: false;
      error: string;
    }
>;

export type ExtremeWorkerCorsInput = Readonly<{
  requestOrigin: string | null;
  allowedOrigins: readonly string[];
}>;

export type ExtremeWorkerCorsHeaders = Readonly<Record<string, string>>;

const DANGEROUS_FILENAME_CHARS = /[\x00-\x1f<>:"/\\|?*]/g;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_FILES = 16;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_BATCH_BYTES = 1536 * 1024 * 1024;

const normalizeSlashes = (value: string) => value.replaceAll("\\", "/");

export const sanitizeExtremeWorkerFileName = (originalName: string, fallbackIndex = 0) => {
  const normalized = normalizeSlashes(originalName);
  if (
    normalized.includes("/") ||
    normalized.includes("..") ||
    normalized.trim() !== originalName
  ) {
    throw new Error("Unsafe file name.");
  }

  const extension = originalName.match(/\.[^.]+$/)?.[0] ?? ".wav";
  const withoutExtension = originalName.slice(0, originalName.length - extension.length);
  const cleanedBase = withoutExtension
    .replace(DANGEROUS_FILENAME_CHARS, "_")
    .replace(/[ .]+$/g, "");
  const safeBase = cleanedBase || `input_${fallbackIndex + 1}`;
  const reservedSafeBase = WINDOWS_RESERVED_BASENAME.test(safeBase)
    ? `${safeBase}_file`
    : safeBase;
  return `${reservedSafeBase}${extension.toLowerCase()}`;
};

const isSupportedWavUpload = (file: ExtremeWorkerUploadFile) => {
  const nameIsWav = /\.wav$/i.test(file.originalName);
  const mime = file.mimeType?.toLowerCase() ?? "";
  const mimeLooksWav =
    mime === "" ||
    mime === "audio/wav" ||
    mime === "audio/wave" ||
    mime === "audio/x-wav" ||
    mime === "application/octet-stream";
  return nameIsWav && mimeLooksWav;
};

export const validateExtremeWorkerUpload = (
  input: Readonly<{ files: readonly ExtremeWorkerUploadFile[] }>,
): ExtremeWorkerUploadValidation => {
  if (input.files.length === 0) return { ok: false, error: "Upload at least one WAV file." };
  if (input.files.length > MAX_FILES) {
    return { ok: false, error: `Upload at most ${MAX_FILES} WAV files per job.` };
  }

  let totalBytes = 0;
  const files: { originalName: string; safeName: string; sizeBytes: number }[] = [];
  for (let index = 0; index < input.files.length; index += 1) {
    const file = input.files[index];
    if (!Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0) {
      return { ok: false, error: "Every upload must contain audio bytes." };
    }
    if (file.sizeBytes > MAX_FILE_BYTES) {
      return { ok: false, error: "A single WAV file exceeds the Extreme worker size limit." };
    }
    if (!isSupportedWavUpload(file)) {
      return { ok: false, error: "Extreme worker accepts WAV audio only." };
    }

    let safeName: string;
    try {
      safeName = sanitizeExtremeWorkerFileName(file.originalName, index);
    } catch {
      return { ok: false, error: "Unsafe file name." };
    }

    totalBytes += file.sizeBytes;
    if (totalBytes > MAX_BATCH_BYTES) {
      return { ok: false, error: "The batch exceeds the Extreme worker size limit." };
    }
    files.push({ originalName: file.originalName, safeName, sizeBytes: file.sizeBytes });
  }

  return Object.freeze({
    ok: true,
    totalBytes,
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
  });
};

export const buildExtremeWorkerCorsHeaders = (
  input: ExtremeWorkerCorsInput,
): ExtremeWorkerCorsHeaders => {
  const requestOrigin = input.requestOrigin?.trim() ?? "";
  if (!requestOrigin || !input.allowedOrigins.includes(requestOrigin)) {
    return Object.freeze({
      Vary: "Origin",
    });
  }

  return Object.freeze({
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  });
};
