/**
 * Keys that `lib/` hands to the UI as data must exist in all nine catalogs.
 *
 * `locales.test.ts` compares the catalogs with each other and with literal
 * `t("...")` calls in the source, so a key that a *function returns* is
 * invisible to it: nothing in the code writes `t("session.waitingInput")`.
 * `session.waitingInput` and `session.waitingApproval` shipped missing exactly
 * that way and the phone printed the raw key over the running turn.
 *
 * Every branch is walked through the real functions instead of listing the keys
 * by hand, so a new status, stream state, failure kind, or push state fails
 * here rather than on a phone.
 */
import { describe, expect, it } from "vitest";

import type { PushRegistrationSnapshot } from "../hooks/usePushRegistration.js";
import { failureReasonKey } from "./direct-chat/view.js";
import { modelSwitchBlockedReason } from "./model-choice.js";
import { describePushSettingsView } from "./settings-view.js";
import { groupSessionsByDate, resolveConnectionBanner, resolveTurnStatusDisplay } from "./session-format.js";
import { CATALOGS, SUPPORTED_LOCALES } from "../locales/index.js";
import type { StreamState } from "./stream-supervisor.js";

/** Every `labelKey`/`messageKey` `session-format.ts` can return. */
function sessionFormatKeys(): string[] {
  const keys: string[] = [];
  const turnStatuses = [
    undefined,
    "queued",
    "running",
    "waiting_input",
    "waiting_approval",
    "interrupted",
    "stopped",
    "completed",
    "a-status-the-client-does-not-know",
  ];
  const decisionKinds = [undefined, "approval", "input"] as const;
  for (const turnStatus of turnStatuses) {
    for (const stopping of [false, true]) {
      for (const decisionKind of decisionKinds) {
        const display = resolveTurnStatusDisplay(turnStatus, stopping, decisionKind);
        if (display) keys.push(display.labelKey);
      }
    }
  }

  const streamStates: StreamState[] = ["idle", "open", "paused", "retrying", "revoked", "exhausted", "stopped"];
  for (const state of streamStates) {
    const banner = resolveConnectionBanner(state);
    if (banner.messageKey) keys.push(banner.messageKey);
  }

  const now = new Date("2026-03-31T15:00:00Z").getTime();
  const day = 24 * 60 * 60 * 1000;
  const groups = groupSessionsByDate(
    [
      { updatedAt: now - 1000 },
      { updatedAt: now - day },
      { updatedAt: now - 3 * day },
      { updatedAt: now - 30 * day },
    ],
    now,
  );
  for (const group of groups) keys.push(group.labelKey);
  return keys;
}

/** Every key `model-choice.ts` and the direct-chat failure reason return. */
function decisionKeys(): string[] {
  const keys: string[] = [];
  for (const running of [true, false]) {
    for (const hasPendingDecision of [true, false]) {
      const blocked = modelSwitchBlockedReason({ running, hasPendingDecision });
      if (blocked) keys.push(blocked);
    }
  }
  const errorKinds: Array<string | null> = [
    "unauthorized",
    "quota",
    "network-range",
    "transport",
    "storage",
    "context-overflow",
    "interrupted",
    "output",
    "a-kind-the-client-does-not-know",
    null,
  ];
  for (const kind of errorKinds) keys.push(failureReasonKey(kind));
  return keys;
}

/** Every `statusKey`/`errorKey` the Settings notifications section renders. */
function pushSettingsKeys(): string[] {
  const base: Pick<
    PushRegistrationSnapshot,
    "state" | "permission" | "registered" | "enabled" | "busy" | "error" | "gatewayDisabled"
  > = {
    state: "disabled",
    permission: "prompt",
    registered: false,
    enabled: false,
    busy: false,
    error: null,
    gatewayDisabled: false,
  };
  const snapshots = [
    { ...base, state: "unsupported" as const },
    { ...base, state: "permission-denied" as const },
    { ...base, state: "registered" as const },
    { ...base, state: "failed" as const },
    { ...base, gatewayDisabled: true },
    { ...base, enabled: true, permission: "granted" as const },
    base,
    { ...base, error: "permission" },
    { ...base, error: "no-token" },
    { ...base, error: "request-failed" },
    { ...base, error: "a-plugin-error" },
  ];
  const keys: string[] = [];
  for (const snapshot of snapshots) {
    const view = describePushSettingsView(snapshot);
    keys.push(view.statusKey);
    if (view.errorKey) keys.push(view.errorKey);
  }
  return keys;
}

const DATA_KEYS = [...new Set([...sessionFormatKeys(), ...decisionKeys(), ...pushSettingsKeys()])].sort();

describe("i18n keys that lib/ returns as data", () => {
  it("walks a realistic number of branches, so an empty list cannot pass", () => {
    expect(DATA_KEYS.length).toBeGreaterThan(20);
  });

  it("names a key every one of the nine catalogs translates", () => {
    const missing: string[] = [];
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of DATA_KEYS) {
        if (!(key in CATALOGS[locale])) missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});