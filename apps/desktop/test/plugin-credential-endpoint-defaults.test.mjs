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