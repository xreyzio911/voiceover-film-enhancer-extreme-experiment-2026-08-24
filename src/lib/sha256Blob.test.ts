import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { sha256Blob } from "./sha256Blob.ts";

const nodeSha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("streaming blob SHA-256 matches standard vectors without whole-blob arrayBuffer", async () => {
  const vectors = [
    new Uint8Array(),
    new TextEncoder().encode("abc"),
    Uint8Array.from({ length: 1_048_731 }, (_, index) => (index * 31 + 17) & 0xff),
  ];

  for (const bytes of vectors) {
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, "arrayBuffer", {
      value: async () => {
        throw new Error("whole-blob buffering is forbidden");
      },
    });
    assert.equal(await sha256Blob(blob), nodeSha256(bytes));
  }
});

test("streaming blob SHA-256 is deterministic across blob part boundaries", async () => {
  const parts = [
    new Uint8Array(63).fill(0x11),
    new Uint8Array(1).fill(0x22),
    new Uint8Array(65).fill(0x33),
    new Uint8Array(131_111).fill(0x44),
  ];
  const combined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  assert.equal(await sha256Blob(new Blob(parts)), nodeSha256(combined));
});
