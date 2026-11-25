/**
 * One credential slot is the whole account: its declared fields, plus the three
 * account-scoped sections a manifest can add — the user's own mail server, the
 * user's own proxy, and the user's own outgoing server.
 *
 * The Settings sheet and the host-owned "add an account" dialog render this same
 * form, so what the first frame shows here is what the user sees in both places.
 * The slot reaches the form through the credential status IPC; what that IPC
 * carries is asserted next to this in `plugin-settings-credentials-ipc.test.mjs`,
 * and this covers what the form does with it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const read = (path) => readFileSync(new URL(`../src/components/plugins/${path}`, import.meta.url), "utf8");

const FIELDS = [
  { key: "username", label: "Address", secret: false },
  { key: "password", label: "Password", secret: true },
  {
    key: "provider",
    label: "Provider",
    secret: false,
    type: "select",
    options: [
      { value: "gmail", label: "Gmail" },
      { value: "custom", label: "Custom" },
    ],
  },
];

async function form(t) {
  const ssr = await slotSsr(t);
  const { CredentialFieldsForm } = await ssr.load("/src/components/plugins/PluginCredentials.tsx");
  return (props = {}) =>
    ssr.render(
      createElement(CredentialFieldsForm, {
        fields: FIELDS,
        values: {},
        onChange: () => {},
        locale: "en",
        ...props,
      }),
      { sessionId: null },
    );
}

test("a mailbox slot shows its own mail server, proxy, and outgoing server", async (t) => {
  const render = await form(t);
  const html = render({
    userEndpoint: { protocols: ["imap", "pop3"] },
    userProxy: { types: ["http", "socks5"] },
    userSend: { security: ["tls", "starttls"] },
  });

  // The account's incoming server.
  assert.match(html, /Use your own mail server/);
  assert.match(html, /Protocol/);
  // The account's own route out, which the report did not see at all.
  assert.match(html, /<summary[^>]*>Proxy<\/summary>/);
  assert.match(html, /Proxy type/);
  // And the account's own outgoing server.
  assert.match(html, /Send with your own server/);
  assert.match(html, /Outgoing server/);
});

test("a slot that declares none of them renders none of them", async (t) => {
  const render = await form(t);
  const html = render();
  for (const section of ["Use your own mail server", "Proxy type", "Send with your own server"]) {
    assert.equal(html.includes(section), false, `${section} must not appear: ${html}`);
  }
  // The declared fields are still there, so this is not an empty form.
  assert.match(html, /Address/);
  assert.match(html, /Provider/);
});

test("a saved value is selected back in a declared dropdown", async (t) => {
  const render = await form(t);
  // The account was created after `provider` existed, so it was stored and the
  // sheet shows it. An account older than the field has no value to show: the
  // host only ever returns values that were entered (spec 07-plugins/03).
  const html = render({ values: { username: "alice@example.test", provider: "gmail" } });
  assert.match(html, /value="alice@example\.test"/);
  assert.match(html, /<option[^>]*value="gmail"[^>]*selected/, html);
});

test("the host-owned dialog asks the same status call and passes both sections on", () => {
  // The dialog has no slot of its own: it reads the declaration from the same
  // status call the sheet uses, so a field missing there is missing here too.
  const dialog = read("PluginCredentialDialog.tsx");
  assert.match(dialog, /api\.getPluginCredentials\(request\.pluginId\)/);
  assert.match(dialog, /userProxy=\{slot\.userProxy\}/);
  assert.match(dialog, /userSend=\{slot\.userSend\}/);
  assert.match(dialog, /userEndpoint=\{slot\.userEndpoint\}/);
});