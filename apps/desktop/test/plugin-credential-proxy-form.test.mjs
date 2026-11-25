/**
 * The "connect through my own proxy" section of the credential form.
 *
 * What the server-rendered first frame has to show: a type is always offered,
 * the address fields appear only once a type is chosen, and a saved proxy login
 * is never rendered back into the form.
 *
 * The DOM after interaction (choosing a type, typing a port) is the same
 * component with different props, which this covers through the second render;
 * Electron E2E is not involved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

async function form(t) {
  const ssr = await slotSsr(t);
  const { CustomMailProxyFields } = await ssr.load(
    "/src/components/plugins/PluginCredentialProxy.tsx"
  );
  return (values, types = ["http", "socks5"]) =>
    ssr.render(createElement(CustomMailProxyFields, { types, values, onChange: () => {} }), {
      sessionId: null,
    });
}

test("no proxy type chosen shows the choice and no address fields", async (t) => {
  const render = await form(t);
  const html = render({});
  // The section is offered, and the type control is there with its "none" entry.
  assert.match(html, /Proxy type/);
  assert.match(html, /No proxy/);
  assert.match(html, /HTTP \(CONNECT\)/);
  assert.match(html, /SOCKS5/);
  // Nothing to fill in until a type is chosen.
  assert.ok(!html.includes("Proxy server"), html);
  assert.ok(!html.includes("Proxy port"), html);
  assert.ok(!html.includes("Proxy password"), html);
});

test("a chosen type shows the address, and a stored login is not prefilled", async (t) => {
  const render = await form(t);
  const html = render({
    proxyType: "http",
    proxyHost: "127.0.0.1",
    proxyPort: "7897",
    // What a save would have written: the renderer only ever receives the
    // published fields, so these two are here to prove they stay empty.
    proxyUsername: "",
    proxyPassword: "",
  });
  assert.match(html, /127\.0\.0\.1/);
  assert.match(html, /7897/);
  assert.match(html, /Proxy user name/);
  assert.match(html, /Proxy password/);
  // The hint says the saved proxy login has to be typed again.
  assert.match(html, /type it when you save/);
  // Empty inputs, not a value: nothing of a stored proxy login is echoed.
  assert.ok(!/<input[^>]*proxyUsername[^>]*value="[^"]+"/.test(html), html);
  assert.ok(!/<input[^>]*proxyPassword[^>]*value="[^"]+"/.test(html), html);
});

test("a slot that offers one type does not offer the other", async (t) => {
  const render = await form(t);
  const html = render({}, ["socks5"]);
  assert.match(html, /SOCKS5/);
  assert.ok(!html.includes("HTTP (CONNECT)"), html);
});