import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { authorizePresetTcpEndpoint } = await import("../electron/main/plugin-tcp-credentials.ts");

const slot = { id: "mailbox", kind: "imap", scope: { domains: ["smtp.example.com"] } };
const manifestTcp = [{ host: "smtp.example.com", port: 587, tls: false }];
const request = { endpoint: { host: "SMTP.EXAMPLE.COM", port: 587 }, manifestTcp };

test("preset SMTP endpoint needs both the literal declaration and credential scope", () => {
  assert.deepEqual(authorizePresetTcpEndpoint(slot, request, false), manifestTcp[0]);
  assert.throws(
    () => authorizePresetTcpEndpoint(slot, { ...request, endpoint: { host: "other.example.com", port: 587 } }, false),
    { code: "PERMISSION_DENIED" },
  );
  assert.throws(
    () => authorizePresetTcpEndpoint({ ...slot, scope: { domains: ["other.example.com"] } }, request, false),
    { code: "PERMISSION_DENIED" },
  );
  assert.throws(() => authorizePresetTcpEndpoint(slot, { manifestTcp }, false), { code: "INVALID_ARGUMENT" });
});

test("IMAP preset still refuses a plaintext endpoint", () => {
  assert.throws(() => authorizePresetTcpEndpoint(slot, request, true), { code: "PERMISSION_DENIED" });
});
