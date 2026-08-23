import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allowedEmails, isAllowedEmail } from "./authAllowlist.ts";

test("authorizes the experimental project owner without removing existing accounts", () => {
  assert.equal(isAllowedEmail("shortsprojektt@gmail.com"), true);
  assert.equal(isAllowedEmail("reyhanputraph@gmail.com"), true);
  assert.equal(isAllowedEmail("xreyzio911@gmail.com"), true);
  assert.equal(isAllowedEmail("XREYZIO911@GMAIL.COM"), true);
  assert.equal(allowedEmails.includes("xreyzio911@gmail.com"), true);
});

test("rejects missing and unapproved accounts", () => {
  assert.equal(isAllowedEmail(undefined), false);
  assert.equal(isAllowedEmail(null), false);
  assert.equal(isAllowedEmail("unknown@example.com"), false);
});

test("localhost bypass runs before next-auth middleware initialization", () => {
  const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  const bootstrapIndex = proxySource.indexOf("bootstrapVercelAuthUrl();");
  const proxyConstructionIndex = proxySource.indexOf("const authenticatedProxy = withAuth(");
  const exportedProxyIndex = proxySource.indexOf("export default function proxy");
  const localBypassIndex = proxySource.indexOf(
    "if (isLocalHost(request.nextUrl.hostname))",
    exportedProxyIndex,
  );
  const authenticatedProxyIndex = proxySource.indexOf(
    "return authenticatedProxy(request, event)",
    exportedProxyIndex,
  );

  assert.ok(bootstrapIndex >= 0, "Vercel URL bootstrap must be present");
  assert.ok(
    proxyConstructionIndex > bootstrapIndex,
    "Vercel URL bootstrap must run before next-auth middleware is constructed",
  );
  assert.ok(exportedProxyIndex >= 0, "proxy must expose an explicit pre-auth dispatcher");
  assert.ok(localBypassIndex > exportedProxyIndex, "localhost must be handled in the dispatcher");
  assert.ok(
    authenticatedProxyIndex > localBypassIndex,
    "localhost bypass must return before next-auth middleware can require provider secrets",
  );
});

test("next-auth middleware uses the same AUTH_SECRET as the route config", () => {
  const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(
    proxySource,
    /withAuth\([\s\S]*\{\s*secret:\s*process\.env\.AUTH_SECRET,/,
    "middleware must not require a separate NEXTAUTH_SECRET in production",
  );
});
