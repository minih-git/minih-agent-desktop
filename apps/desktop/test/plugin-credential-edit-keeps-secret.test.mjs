/**
 * Editing an account that already has a password.
 *
 * A stored secret never comes back to the form, so the edit shows an empty box
 * for it. That empty box has to be a valid answer — the user may only be adding a
 * proxy — and the form has to say so, plus name the server a saved password is
 * about to be handed to. A new account has nothing to keep, so its secrets stay
 * required.
 *
 * The form is loaded through the same Vite SSR path the app uses, so these
 * assertions run against the production component rather than a copy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const read = (path) =>
  readFileSync(new URL(`../src/components/plugins/${path}`, import.meta.url), "utf8");

const FIELDS = [
  { key: "username", label: "Address", secret: false },
  { key: "password", label: "App password", secret: true },
];

const MAILBOX_SLOT = {
  id: "mailbox",
  title: "Mailbox",
  kind: "imap",
  configured: true,
  lastUsedAt: null,
  fields: [
    { key: "username", label: "Address", secret: false },
    { key: "password", label: "App password", secret: true },
    {
      key: "provider",
      label: "Provider",
      secret: false,
      type: "select",
      options: [
        { value: "gmail", label: "Gmail" },
        { value: "qq", label: "QQ Mail" },
      ],
    },
  ],
  userEndpoint: { protocols: ["imap", "pop3"] },
  userSend: { security: ["tls", "starttls"] },
};

async function modules(t) {
  const ssr = await slotSsr(t);
  return {
    ssr,
    credentials: await ssr.load("/src/components/plugins/PluginCredentials.tsx"),
    hint: await ssr.load("/src/components/plugins/credential-edit-hint.ts"),
  };
}

test("a saved secret may stay empty on an edit, and only there", async (t) => {
  const { credentials } = await modules(t);
  const { valuesComplete } = credentials;

  // A new account has nothing to keep.
  assert.equal(valuesComplete(FIELDS, { username: "alice@example.test" }), false);
  // An edit does: the host keeps what is stored under the account's id.
  assert.equal(valuesComplete(FIELDS, { username: "alice@example.test" }, false), true);
  // A typed secret is still a complete answer.
  assert.equal(
    valuesComplete(FIELDS, { username: "alice@example.test", password: "typed" }, false),
    true,
  );
  // Every non-secret field is still required, edit or not.
  assert.equal(valuesComplete(FIELDS, { password: "typed" }, false), false);
});

test("the secret box says what an empty answer means", async (t) => {
  const { ssr, credentials } = await modules(t);
  const render = (props) =>
    ssr.render(
      createElement(credentials.CredentialFieldsForm, {
        fields: FIELDS,
        values: {},
        onChange: () => {},
        locale: "en",
        ...props,
      }),
      { sessionId: null },
    );

  // Editing an account: the box promises to keep what is saved.
  assert.match(render({ keepingSecrets: true }), /Leave empty to keep the saved App password/);
  // A new account: nothing to promise, so nothing is claimed.
  assert.equal(render({}).includes("Leave empty to keep the saved"), false);
});

test("a change of server is named before the saved password is reused", async (t) => {
  const { hint } = await modules(t);
  const { savedSecretLoginTarget } = hint;
  const saved = {
    username: "alice@example.test",
    provider: "gmail",
    server: "imap.gmail.com",
    port: "993",
    sendServer: "smtp.gmail.com",
    sendPort: "587",
  };

  // Nothing moved, or the user typed a password: nothing to announce.
  assert.equal(savedSecretLoginTarget(MAILBOX_SLOT, saved, { ...saved }), null);
  assert.equal(
    savedSecretLoginTarget(MAILBOX_SLOT, saved, { ...saved, password: "typed" }),
    null,
  );

  // A provider change names the provider.
  assert.equal(
    savedSecretLoginTarget(MAILBOX_SLOT, saved, { ...saved, provider: "qq" }),
    "QQ Mail",
  );
  // The account's own incoming server, with its port.
  assert.equal(
    savedSecretLoginTarget(MAILBOX_SLOT, saved, { ...saved, server: "imap.other.example" }),
    "imap.other.example:993",
  );
  // Its own outgoing server.
  assert.equal(
    savedSecretLoginTarget(MAILBOX_SLOT, saved, { ...saved, sendServer: "smtp.other.example" }),
    "smtp.other.example:587",
  );
  // A slot with no secret field has nothing to reuse.
  assert.equal(
    savedSecretLoginTarget({ ...MAILBOX_SLOT, fields: [FIELDS[0]] }, saved, {
      ...saved,
      provider: "qq",
    }),
    null,
  );
});

test("the sheet asks the form the right question for each mode", () => {
  const sheet = read("PluginCredentials.tsx");
  // Editing: secrets may stay empty, and the boxes say so.
  assert.match(sheet, /!valuesComplete\(slot\.fields, values, !editing\)/);
  assert.match(sheet, /keepingSecrets=\{Boolean\(editing\)\}/);
  // A single-value slot is edited in place once it is configured.
  assert.match(sheet, /!valuesComplete\(slot\.fields, values, !slot\.configured\)/);
  assert.match(sheet, /keepingSecrets=\{Boolean\(slot\.configured\)\}/);
  // The line above the save button names the destination.
  assert.match(sheet, /pluginCredentials\.keepSavedSecretLogin/);
});