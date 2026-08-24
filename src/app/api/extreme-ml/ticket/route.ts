import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerAuthSession } from "@/auth";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { readBoundedJson } from "@/lib/boundedRequestJson";
import {
  normalizeExtremeWorkerAllowedOrigins,
  normalizeExtremeWorkerBaseUrl,
} from "@/lib/extremeMlClient";
import {
  consumeFixedWindowRateLimit,
  type FixedWindowRateLimitState,
} from "@/lib/fixedWindowRateLimit";
import { isLocalHost } from "@/lib/isLocalHost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TicketErrorCode = "auth" | "bad_request" | "config" | "rate_limit" | "worker";
type AnalysisScope = "source_analysis" | "render_analysis" | "enhancement_candidate";
type TicketRequest = Readonly<{
  sizeBytes: number;
  contentType: "audio/wav" | "audio/x-wav";
  idempotencyKey: string;
  scope: AnalysisScope;
  sha256: string;
}>;

const MAX_METADATA_BYTES = 8 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_MAX_ENTRIES = 256;
let rateLimitState: FixedWindowRateLimitState = new Map();

const jsonError = (error: string, status: number, code: TicketErrorCode) =>
  NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isEnabled = () => ["1", "true", "on", "yes"].includes(
  (process.env.EXTREME_ML_ENABLED ?? "").trim().toLowerCase(),
);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAnalysisScope = (value: unknown): value is AnalysisScope =>
  value === "source_analysis" || value === "render_analysis" || value === "enhancement_candidate";

const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const readIdentity = async (request: NextRequest) => {
  if (isLocalHost(request.nextUrl.hostname)) return "local-development";
  const session = await getServerAuthSession();
  const email = session?.user?.email;
  return isAllowedEmail(email) ? email?.trim().toLowerCase() ?? null : null;
};

const consumeRateLimit = (identity: string) => {
  const result = consumeFixedWindowRateLimit({
    state: rateLimitState,
    key: identity,
    nowMs: Date.now(),
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxRequests: RATE_LIMIT_MAX,
    maxEntries: RATE_LIMIT_MAX_ENTRIES,
  });
  rateLimitState = result.state;
  return result.allowed;
};

const normalizeTicketRequest = (value: unknown): TicketRequest | null => {
  if (!isPlainRecord(value)) return null;
  const { sizeBytes, contentType, idempotencyKey, scope, sha256 } = value;
  const maxBytes = parsePositiveInteger(process.env.EXTREME_ML_MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES);
  if (
    !Number.isSafeInteger(sizeBytes)
    || (sizeBytes as number) <= 0
    || (sizeBytes as number) > maxBytes
    || (contentType !== "audio/wav" && contentType !== "audio/x-wav")
    || typeof idempotencyKey !== "string"
    || idempotencyKey.length < 1
    || idempotencyKey.length > 128
    || !/^[A-Za-z0-9._:@+-]+$/.test(idempotencyKey)
    || !isAnalysisScope(scope)
    || !isSha256Hex(sha256)
  ) return null;
  return Object.freeze({
    sizeBytes: sizeBytes as number,
    contentType,
    idempotencyKey,
    scope,
    sha256,
  });
};

const normalizeTicketResponse = (value: unknown) => {
  if (!isPlainRecord(value)) return null;
  const { ticket, expiresAt } = value;
  if (
    typeof ticket !== "string"
    || ticket.length < 16
    || ticket.length > 8_192
    || typeof expiresAt !== "string"
    || expiresAt.length > 80
    || !Number.isFinite(Date.parse(expiresAt))
  ) return null;
  return Object.freeze({ ticket, expiresAt });
};

export async function POST(request: NextRequest) {
  const identity = await readIdentity(request);
  if (!identity) return jsonError("Unauthorized", 401, "auth");
  if (!isEnabled()) return jsonError("Extreme ML analysis is disabled.", 503, "config");
  if (!consumeRateLimit(identity)) {
    return jsonError("Too many analysis requests. Wait a few minutes and try again.", 429, "rate_limit");
  }

  const rawPayload = await readBoundedJson(request, MAX_METADATA_BYTES);
  if (!rawPayload.ok && rawPayload.error === "too_large") {
    return jsonError("Metadata request is too large.", 413, "bad_request");
  }
  if (!rawPayload.ok) {
    return jsonError("Expected a JSON metadata payload.", 400, "bad_request");
  }
  const payload = normalizeTicketRequest(rawPayload.value);
  if (!payload) return jsonError("Invalid analysis metadata.", 400, "bad_request");

  const allowLocalDevelopment = process.env.NODE_ENV !== "production";
  const allowedWorkerOrigins = normalizeExtremeWorkerAllowedOrigins(
    process.env.EXTREME_ML_ALLOWED_WORKER_ORIGINS,
    allowLocalDevelopment,
  );
  const workerBaseUrl = allowedWorkerOrigins
    ? normalizeExtremeWorkerBaseUrl(
        process.env.EXTREME_ML_WORKER_URL,
        allowedWorkerOrigins,
        allowLocalDevelopment,
      )
    : null;
  const internalSecret = process.env.EXTREME_ML_INTERNAL_SECRET ?? "";
  if (!workerBaseUrl || internalSecret.length < 32) {
    return jsonError("Extreme ML worker is not configured.", 503, "config");
  }

  const ownerHash = createHmac("sha256", internalSecret).update(identity).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    parsePositiveInteger(process.env.EXTREME_ML_TICKET_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  );
  try {
    const workerResponse = await fetch(`${workerBaseUrl}/internal/v1/tickets`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${internalSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ownerHash, ...payload }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!workerResponse.ok) return jsonError("Extreme ML worker is unavailable.", 502, "worker");
    const ticketPayload = normalizeTicketResponse(await workerResponse.json().catch(() => null));
    if (!ticketPayload) return jsonError("Extreme ML worker returned an invalid ticket.", 502, "worker");
    return NextResponse.json(
      { workerBaseUrl, ...ticketPayload },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonError("Extreme ML worker is unavailable.", 502, "worker");
  } finally {
    clearTimeout(timer);
  }
}
