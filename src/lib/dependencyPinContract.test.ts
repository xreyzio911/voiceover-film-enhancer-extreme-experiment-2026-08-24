import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

test("nanoid stays pinned through npm overrides and the lockfile", () => {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    overrides?: Record<string, string>;
  };
  const packageLock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };

  assert.equal(packageJson.overrides?.nanoid, "3.3.18");
  assert.equal(packageLock.packages?.["node_modules/nanoid"]?.version, "3.3.18");
});
