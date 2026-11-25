/**
 * The four port defaults of the "your own mail server" form.
 *
 * The form is the only place the app decides a value the user did not type, and
 * a wrong default sends the password to a port nobody is listening on (or, worse,
 * to a plaintext service). The mapping is checked here so the renderer test can
 * stay about interaction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { DEFAULT_MAIL_PORTS, defaultMailPort } = await import(
  "../src/components/plugins/mail-endpoint.ts"
);

test("every protocol and transport has its registered port", () => {
  assert.deepEqual(DEFAULT_MAIL_PORTS, {
    imap: { tls: 993, starttls: 143 },
    pop3: { tls: 995, starttls: 110 },
  });
  assert.equal(defaultMailPort("imap", "tls"), "993");
  assert.equal(defaultMailPort("imap", "starttls"), "143");
  assert.equal(defaultMailPort("pop3", "tls"), "995");
  assert.equal(defaultMailPort("pop3", "starttls"), "110");
});

test("an unknown or missing choice falls back to the safe IMAP/TLS pair", () => {
  assert.equal(defaultMailPort("", ""), "993");
  assert.equal(defaultMailPort("smtp", "none"), "993");
  assert.equal(defaultMailPort("pop3", ""), "995");
});

test("submission defaults are 465 for TLS and 587 for an upgrade", async () => {
  const { DEFAULT_SEND_PORTS, defaultSendPort } = await import(
    "../src/components/plugins/mail-endpoint.ts"
  );
  assert.deepEqual(DEFAULT_SEND_PORTS, { tls: 465, starttls: 587 });
  assert.equal(defaultSendPort("tls"), "465");
  assert.equal(defaultSendPort("starttls"), "587");
  // A missing or unknown transport is the implicit-TLS port: STARTTLS is never
  // assumed on a port that may not offer it.
  assert.equal(defaultSendPort(""), "465");
  assert.equal(defaultSendPort("none"), "465");
});