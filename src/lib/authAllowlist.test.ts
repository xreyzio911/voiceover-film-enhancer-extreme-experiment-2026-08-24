import assert from "node:assert/strict";
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
