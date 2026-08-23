export type BoundedJsonReadResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; error: "too_large" | "invalid_json" }>;

const TOO_LARGE = Object.freeze({ ok: false, error: "too_large" } as const);
const INVALID_JSON = Object.freeze({ ok: false, error: "invalid_json" } as const);

const declaredLengthExceeds = (value: string | null, maxBytes: number) => {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return false;
  try {
    return BigInt(normalized) > BigInt(maxBytes);
  } catch {
    return true;
  }
};

const cancelQuietly = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  try {
    await reader.cancel("request body limit reached");
  } catch {
    // The bounded result is authoritative even if an already-failed stream cannot be cancelled.
  }
};

export const readBoundedJson = async (
  request: Request,
  maxBytes: number,
): Promise<BoundedJsonReadResult> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (declaredLengthExceeds(request.headers.get("content-length"), maxBytes)) {
    return TOO_LARGE;
  }
  if (!request.body) return INVALID_JSON;

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return INVALID_JSON;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelQuietly(reader);
        return TOO_LARGE;
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    const text = fragments.join("");
    if (!text.trim()) return INVALID_JSON;
    return Object.freeze({ ok: true, value: JSON.parse(text) });
  } catch {
    await cancelQuietly(reader);
    return INVALID_JSON;
  } finally {
    reader.releaseLock();
  }
};
