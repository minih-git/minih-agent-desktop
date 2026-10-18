/**
 * Remote gateway: pure decisions and catalogs (rollout R5, ADR 0331).
 *
 * The page's behaviour — the switch gate, enrollment, the pairing code, revoke,
 * unmount cleanup — is covered by rendering it in Electron in
 * `remote-gateway-settings-user-path.test.mjs`. What remains here are the
 * decisions that hold without a DOM (which link state maps to which copy, which
 * failure earns which message, when a pairing code stops being usable) plus the
 * catalog and settings-navigation contracts those decisions depend on.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  pairingCodeExpired,
  pairingCodeRemainingLabel,
  remoteGatewayErrorKey,
  remoteGatewayStateKey,
  remoteGatewaySwitchDisabled,
  REMOTE_GATEWAY_PAIRING_CODE_LIFETIME_MS,
} = await import("../src/lib/remote-gateway-state.ts");
const { GATEWAY_PAIRING_CODE_LIFETIME_MS } = await import(
  "../electron/main/remote/gateway-link/gateway-link-service.ts"
);
const { SETTINGS_NAV, visibleSettingsNav } = await import("../src/lib/settings-search.ts");
const { catalogs, en, flattenCatalog } = await import("@minih-agent/i18n");

const LINK_STATES = [
  "disabled",
  "not-enrolled",
  "enrolling",
  "starting",
  "connecting",
  "connected",
  "backoff",
  "rejected",
  "error",
];

const english = flattenCatalog(en);

test("the switch is offered only once the desktop is registered", () => {
  assert.equal(remoteGatewaySwitchDisabled(null), true);
  // A registered but disabled link may be turned back on.
  assert.equal(
    remoteGatewaySwitchDisabled({ state: "disabled", since: "", enabled: false, enrolled: true }),
    false,
  );
  // An unregistered desktop has nothing to dial.
  assert.equal(
    remoteGatewaySwitchDisabled({ state: "disabled", since: "", enabled: false, enrolled: false }),
    true,
  );
  assert.equal(
    remoteGatewaySwitchDisabled({ state: "not-enrolled", since: "", enabled: false, enrolled: false }),
    true,
  );
  // A running link is never hidden behind a disabled switch.
  assert.equal(
    remoteGatewaySwitchDisabled({ state: "error", since: "", enabled: true, enrolled: true }),
    false,
  );
});

test("every link state resolves to copy in all nine locales", () => {
  for (const state of LINK_STATES) {
    const key = remoteGatewayStateKey(state);
    assert.match(key, /^settings\.remoteGateway\.state/);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const copy = flattenCatalog(catalog)[key];
      assert.equal(typeof copy, "string", `${locale}: missing copy for ${state}`);
      assert.ok(copy.trim().length > 0, `${locale}: blank copy for ${state}`);
    }
  }
  // The nine states are distinct keys, so a new state cannot silently reuse one.
  assert.equal(new Set(LINK_STATES.map(remoteGatewayStateKey)).size, LINK_STATES.length);
});

test("a build without the transport gets its own message, not a generic failure", () => {
  const code = (value) => Object.assign(new Error("boom"), { errorCode: value });
  const mapped = [
    ["GATEWAY_LINK_UNAVAILABLE", "settings.remoteGateway.errorUnavailable"],
    ["GATEWAY_CREDENTIALS_UNREADABLE", "settings.remoteGateway.errorCredentials"],
    ["GATEWAY_CREDENTIALS_STORAGE_UNAVAILABLE", "settings.remoteGateway.errorCredentials"],
    ["AGENT_UNAVAILABLE", "settings.remoteGateway.errorHostUnavailable"],
    ["INVALID_ARGUMENT", "settings.remoteGateway.errorInvalidInput"],
    ["GATEWAY_LINK_ENROLL_FAILED", "settings.remoteGateway.errorUnknown"],
    ["SOMETHING_ELSE", "settings.remoteGateway.errorUnknown"],
  ];
  for (const [errorCode, key] of mapped) {
    assert.equal(remoteGatewayErrorKey(code(errorCode)), key, errorCode);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      assert.equal(typeof flattenCatalog(catalog)[key], "string", `${locale}: missing ${key}`);
    }
  }
  // An error without a code, a bare string, and nothing at all fall back.
  assert.equal(remoteGatewayErrorKey(new Error("no code")), "settings.remoteGateway.errorUnknown");
  assert.equal(remoteGatewayErrorKey("string failure"), "settings.remoteGateway.errorUnknown");
  assert.equal(remoteGatewayErrorKey(undefined), "settings.remoteGateway.errorUnknown");
  // The unavailable copy names the missing transport rather than a network fault.
  assert.match(english["settings.remoteGateway.errorUnavailable"], /transport/);
});

test("every enrollment failure keeps its own reason", () => {
  // The eight codes `enrollHostLink` / the Gateway can report (PR-2 contract).
  // None may fall through to the generic copy: a wrong CA, a spent code, and a
  // revoked desktop need different instructions.
  const code = (value) => Object.assign(new Error("boom"), { errorCode: value });
  const expected = {
    GATEWAY_UNREACHABLE: "settings.remoteGateway.errorGatewayUnreachable",
    GATEWAY_IDENTITY_MISMATCH: "settings.remoteGateway.errorGatewayIdentity",
    ENROLLMENT_RESPONSE_INVALID: "settings.remoteGateway.errorEnrollmentResponse",
    ENROLLMENT_CODE_INVALID: "settings.remoteGateway.errorEnrollmentCode",
    ENROLLMENT_CODE_EXPIRED: "settings.remoteGateway.errorEnrollmentCode",
    ENROLLMENT_CODE_USED: "settings.remoteGateway.errorEnrollmentCode",
    CSR_INVALID: "settings.remoteGateway.errorEnrollmentResponse",
    HOST_REVOKED: "settings.remoteGateway.errorHostRevoked",
  };
  assert.equal(Object.keys(expected).length, 8);
  for (const [errorCode, key] of Object.entries(expected)) {
    assert.equal(remoteGatewayErrorKey(code(errorCode)), key, errorCode);
    assert.notEqual(remoteGatewayErrorKey(code(errorCode)), "settings.remoteGateway.errorUnknown", errorCode);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      assert.equal(typeof flattenCatalog(catalog)[key], "string", `${locale}: missing ${key}`);
    }
  }
  // The distinct reasons do not collapse into three generic buckets beyond
  // what the copy intends: code reasons share one message, the identity and
  // revocation reasons stay separate.
  const keys = new Set(Object.keys(expected).map((errorCode) => remoteGatewayErrorKey(code(errorCode))));
  assert.equal(keys.size, 5);
});

test("a pairing code counts down and stops being usable when it expires", () => {
  // The page and main agree on the ten-minute lifetime.
  assert.equal(REMOTE_GATEWAY_PAIRING_CODE_LIFETIME_MS, GATEWAY_PAIRING_CODE_LIFETIME_MS);
  assert.equal(REMOTE_GATEWAY_PAIRING_CODE_LIFETIME_MS, 600_000);
  assert.equal(pairingCodeRemainingLabel(600_000), "10:00");
  assert.equal(pairingCodeRemainingLabel(61_000), "1:01");
  assert.equal(pairingCodeRemainingLabel(999), "0:01");
  assert.equal(pairingCodeRemainingLabel(0), "0:00");
  assert.equal(pairingCodeRemainingLabel(-5_000), "0:00");

  const now = Date.parse("2026-10-18T00:05:00.000Z");
  assert.equal(pairingCodeExpired("2026-10-18T00:10:00.000Z", now), false);
  // The deadline itself is already past: a code is never redeemable twice.
  assert.equal(pairingCodeExpired("2026-10-18T00:05:00.000Z", now), true);
  assert.equal(pairingCodeExpired("2026-10-18T00:04:59.000Z", now), true);
  // A deadline that cannot be parsed is treated as expired, not as endless.
  assert.equal(pairingCodeExpired("not a date", now), true);
});

test("the pairing ticket has its own copy in all nine locales", () => {
  // The ticket is what a browser client pastes: the code alone names no Host.
  const keys = [
    "settings.remoteGateway.pairingTicket",
    "settings.remoteGateway.pairingTicketHint",
    "settings.remoteGateway.pairingTicketCopy",
    "settings.remoteGateway.pairingTicketCopied",
  ];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of keys) {
      assert.equal(typeof flat[key], "string", `${locale}: missing ${key}`);
      assert.ok(flat[key].trim().length > 0, `${locale}: blank ${key}`);
    }
    // The two copy buttons sit side by side and the page finds them by text,
    // so the ticket labels must never collapse onto the code labels.
    assert.notEqual(flat["settings.remoteGateway.pairingTicketCopy"], flat["settings.remoteGateway.pairingCopy"], locale);
    assert.notEqual(flat["settings.remoteGateway.pairingTicketCopied"], flat["settings.remoteGateway.pairingCopied"], locale);
  }
  assert.match(english["settings.remoteGateway.pairingTicketHint"], /ticket/i);
});

test("the page is an experimental settings destination next to remote hosts", () => {
  const entries = SETTINGS_NAV.filter((entry) => entry.id === "remoteGateway");
  assert.equal(entries.length, 1, "remote gateway must be one settings destination");
  const [entry] = entries;
  assert.equal(entry.labelKey, "settings.nav.remoteGateway");
  assert.equal(entry.titleKey, "settings.remoteGateway.title");
  assert.equal(entry.group, "system");
  assert.equal(entry.experimentalBadgeKey, "settings.remoteHosts.experimental");
  // It ships in packaged builds: neither gated on developer mode nor dev-only.
  assert.equal(entry.developerOnly, undefined);
  assert.equal(entry.developmentOnly, undefined);
  // It sits beside Remote Hosts, and both are reachable from the rail.
  const order = SETTINGS_NAV.map((candidate) => candidate.id);
  assert.ok(Math.abs(order.indexOf("remoteGateway") - order.indexOf("remoteHosts")) <= 2);
  assert.ok(visibleSettingsNav(false, false).some((candidate) => candidate.id === "remoteGateway"));
  // Every key the entry advertises exists in all nine locales.
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of [entry.labelKey, entry.titleKey, entry.experimentalBadgeKey, ...entry.keywordKeys]) {
      assert.equal(typeof flat[key], "string", `${locale}: missing ${key}`);
    }
  }
});
