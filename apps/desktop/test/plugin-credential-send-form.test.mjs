/**
 * The "send through my own server" section of the credential form.
 *
 * What the first frame has to show: the section is offered only for a slot that
 * declares it, the transport list is the one the manifest asks for, and a saved
 * server is rendered back exactly as stored so the user can see where their mail
 * leaves from.
 *
 * The interaction (choosing a transport, typing a port) is the same component
 * with different props, which the second and third renders cover; Electron E2E is
 * not involved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

async function form(t) {
  const ssr = await slotSsr(t);
  const { CustomMailSendFields } = await ssr.load(
    "/src/components/plugins/PluginCredentialSend.tsx",
  );
  return (values, security = ["tls", "starttls"]) =>
    ssr.render(
      createElement(CustomMailSendFields, { security, values, onChange: () => {} }),
      { sessionId: null },
    );
}

test("the section offers a server, a transport and a port, and nothing is prefilled", async (t) => {
  const render = await form(t);
  const html = render({});
  assert.match(html, /Send with your own server/);
  assert.match(html, /Outgoing server/);
  assert.match(html, /Outgoing encryption/);
  assert.match(html, /Outgoing port/);
  assert.match(html, /smtp\.example\.com/);
  // Both transports the manifest declares are offered.
  assert.match(html, /SSL\/TLS/);
  assert.match(html, /STARTTLS/);
  // Nothing is stored yet, so nothing is filled in.
  assert.ok(!/<input[^>]*sendServer[^>]*value="[^"]+"/.test(html), html);
  assert.ok(!/<input[^>]*sendPort[^>]*value="[^"]+"/.test(html), html);
});

test("a saved server is rendered back, so the account says where it sends from", async (t) => {
  const render = await form(t);
  const html = render({
    sendServer: "smtp.example.test",
    sendPort: "587",
    sendSecurity: "starttls",
  });
  assert.match(html, /smtp\.example\.test/);
  assert.match(html, /value="587"/);
  assert.match(html, /value="starttls"[^>]*selected|selected[^>]*value="starttls"/);
});

test("a slot that allows only one transport offers only that one", async (t) => {
  const render = await form(t);
  const html = render({}, ["starttls"]);
  assert.match(html, /STARTTLS/);
  assert.ok(!html.includes("SSL/TLS"), html);
});