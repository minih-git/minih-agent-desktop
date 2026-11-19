import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { WebhookSourceFilter, normalizeWebhookSource } = await import("../electron/main/plugin-webhook-network.ts");

function network(address, netmask) {
  return { address, netmask, family: address.includes(":") ? "IPv6" : "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: null };
}

test("scoped IPv6 peer addresses are normalized for persistent metadata", () => {
  assert.equal(normalizeWebhookSource("fe80::1%en0"), "fe80::1");
  assert.equal(normalizeWebhookSource("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeWebhookSource(undefined), undefined);
});

test("allows local and overlay subnet peers but refuses other addresses", () => {
  const filter = new WebhookSourceFilter(() => ({
    overlay: [network("11.11.11.6", "255.255.255.0")],
    ipv6: [network("2001:db8:1234::1", "ffff:ffff:ffff:ffff::")],
  }));
  for (const address of ["127.0.0.1", "10.2.3.4", "172.31.1.1", "192.168.1.2", "169.254.2.3", "::1", "fe80::1%en0", "fd00::1", "::ffff:10.0.0.1", "11.11.11.7", "2001:db8:1234::8"]) {
    assert.equal(filter.allows(address), true, address);
  }
  for (const address of [undefined, "not-an-address", "8.8.8.8", "172.32.1.1", "11.11.12.1", "2001:db8:1235::8"]) {
    assert.equal(filter.allows(address), false, String(address));
  }
});

test("refreshes interface subnets after the cache expires", () => {
  let time = 0;
  let interfaces = { overlay: [network("11.11.11.6", "255.255.255.0")] };
  const filter = new WebhookSourceFilter(() => interfaces, () => time);
  assert.equal(filter.allows("11.11.11.9"), true);
  interfaces = { overlay: [network("12.12.12.6", "255.255.255.0")] };
  time = 4_999;
  assert.equal(filter.allows("11.11.11.9"), true);
  time = 5_000;
  assert.equal(filter.allows("11.11.11.9"), false);
  assert.equal(filter.allows("12.12.12.9"), true);
});

test("ignores invalid and non-contiguous interface netmasks", () => {
  const filter = new WebhookSourceFilter(() => ({
    invalid: [network("11.11.11.6", "255.0.255.0"), network("12.12.12.6", "bad")],
  }));
  assert.equal(filter.allows("11.11.11.9"), false);
  assert.equal(filter.allows("12.12.12.9"), false);
});

test("ignores broad interface subnets while retaining CGNAT and narrow networks", () => {
  const filter = new WebhookSourceFilter(() => ({
    defaultRoute: [network("11.1.2.3", "0.0.0.0")],
    broad4: [network("12.1.2.3", "255.0.0.0")],
    narrow4: [network("13.1.2.3", "255.255.0.0")],
    broad6: [network("2001:db8::1", "ffff:ffff::")],
    narrow6: [network("2001:db9:1234::1", "ffff:ffff:ffff::")],
  }));
  for (const address of ["8.8.8.8", "12.1.3.4", "2001:db8::2"]) {
    assert.equal(filter.allows(address), false, address);
  }
  for (const address of ["100.64.0.1", "100.127.255.254", "13.1.3.4", "2001:db9:1234::2"]) {
    assert.equal(filter.allows(address), true, address);
  }
  assert.equal(filter.allows("100.128.0.1"), false);
});
