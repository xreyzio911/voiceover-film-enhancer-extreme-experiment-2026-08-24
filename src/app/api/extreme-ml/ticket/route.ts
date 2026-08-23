import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerAuthSession } from "@/auth";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { normalizeExtremeWorkerBaseUrl } from "@/lib/extremeMlClient";
import { isLocalHost } from "@/lib/isLocalHost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TicketErrorCode = "auth" | "bad_request" | "config" | "rate_limit" | "worker";

const MAX_METADATA_BYTES = 8 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const RATE_LIMIT_MAX = 40;
const rateLimitState = new Map<string, Readonly<{ count: number; resetAtMs: number }>>();

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

const readIdentity = async (request: NextRequest) => {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (isLocalHost(host)) return "local-development";
  const session = await getServerAuthSession();
  const email = session?.user?.email;
  return isAllowedEmail(email) ? email?.trim().toLowerCase() ?? null : null;
};

const clientKey = (request: NextRequest) => {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "unknown";
  return `${forwardedFor || host}:extreme-ml-ticket`;
};

const consumeRateLimit = (key: string) => {
  const now = Date.now();
  const current = rateLimitState.get(key);
  if (!current || current.resetAtMs <= now) {
    rateLimitState.set(key, Object.freeze({ count: 1, resetAtMs: now + RATE_LIMIT_WINDOW_MS }));
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) return false;
  rateLimitState.set(key, Object.freeze({ ...current, count: current.count + 1 }));
  return true;
};

const normalizeTicketRequest = (value: unknown) => {
  if (!isPlainRecord(value)) return null;
  const { sizeBytes, contentType, idempotencyKey, scope } = value;
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
    || scope !== "source_analysis"
  ) return null;
  return Object.freeze({
    sizeBytes: sizeBytes as number,
    contentType,
    idempotencyKey,
    scope: "source_analysis" as const,
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
  if (!consumeRateLimit(clientKey(request))) {
    return jsonError("Too many analysis requests. Wait a few minutes and try again.", 429, "rate_limit");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_METADATA_BYTES) {
    return jsonError("Metadata request is too large.", 413, "bad_request");
  }

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return jsonError("Expected a JSON metadata payload.", 400, "bad_request");
  }
  const payload = normalizeTicketRequest(rawPayload);
  if (!payload) return jsonError("Invalid analysis metadata.", 400, "bad_request");

  const workerBaseUrl = normalizeExtremeWorkerBaseUrl(process.env.EXTREME_ML_WORKER_URL);
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
