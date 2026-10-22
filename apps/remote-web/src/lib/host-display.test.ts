import { describe, expect, it } from "vitest";
import type { HostStatusView } from "../hooks/useHostStatus.js";
import type { HostRegistryEntry } from "./host-registry.js";
import {
  formatHostStatusHelp,
  formatHostStatusLine,
  getHostDisplayInfo,
  hostDotStatus,
  hostStatusAction,
} from "./host-display.js";

const mockT = (key: string, options?: Record<string, unknown>) => {
  if (options && "message" in options) {
    return `${key}:${String(options.message)}`;
  }
  return key;
};

const dummyEntry: HostRegistryEntry = {
  hostId: "host-1",
  label: "MacBook Pro",
  deviceId: "dev-1",
  pairedAt: "2026-01-01",
};

const strictEntry: HostRegistryEntry = {
  ...dummyEntry,
  requiresOwnConfirmation: true,
};

describe("hostDotStatus", () => {
  it("maps statuses to correct dot states", () => {
    expect(hostDotStatus({ kind: "online" })).toBe("online");
    expect(hostDotStatus({ kind: "checking" })).toBe("muted");
    expect(hostDotStatus({ kind: "offline" })).toBe("offline");
    expect(hostDotStatus({ kind: "revoked" })).toBe("error");
    expect(hostDotStatus({ kind: "unaccepted" })).toBe("offline");
    expect(hostDotStatus({ kind: "error", code: "FAIL", message: "fail" })).toBe("error");
  });
});

describe("formatHostStatusLine", () => {
  it("formats status lines using translation keys", () => {
    expect(formatHostStatusLine({ kind: "online" }, mockT)).toBe("hosts.status.online");
    expect(formatHostStatusLine({ kind: "checking" }, mockT)).toBe("hosts.status.checking");
    expect(formatHostStatusLine({ kind: "offline" }, mockT)).toBe("hosts.status.offline");
    expect(formatHostStatusLine({ kind: "revoked" }, mockT)).toBe("hosts.status.revoked");
    expect(formatHostStatusLine({ kind: "unaccepted" }, mockT)).toBe("hosts.status.unaccepted");
    expect(formatHostStatusLine({ kind: "error", code: "ERR", message: "m" }, mockT)).toBe("hosts.status.error");
  });
});

describe("formatHostStatusHelp", () => {
  it("formats help strings for various states", () => {
    expect(formatHostStatusHelp({ kind: "online" }, dummyEntry, mockT)).toBeNull();
    expect(formatHostStatusHelp({ kind: "checking" }, dummyEntry, mockT)).toBeNull();
    expect(formatHostStatusHelp({ kind: "offline" }, dummyEntry, mockT)).toBe("hosts.expand.offlineHelp");
    expect(formatHostStatusHelp({ kind: "revoked" }, dummyEntry, mockT)).toBe("hosts.expand.revokedHelp");
    expect(formatHostStatusHelp({ kind: "unaccepted" }, dummyEntry, mockT)).toBe("hosts.expand.unacceptedHelp");
    expect(formatHostStatusHelp({ kind: "unaccepted" }, strictEntry, mockT)).toBe("hosts.unacceptedStrictHint");
    expect(formatHostStatusHelp({ kind: "error", code: "ERR", message: "Boom" }, dummyEntry, mockT)).toBe("Boom");
  });
});

describe("hostStatusAction", () => {
  it("resolves primary action button per state", () => {
    expect(hostStatusAction({ kind: "online" })).toEqual({ action: "none", labelKey: "" });
    expect(hostStatusAction({ kind: "offline" })).toEqual({ action: "refresh", labelKey: "common.refresh" });
    expect(hostStatusAction({ kind: "unaccepted" })).toEqual({ action: "askAgain", labelKey: "hosts.sheet.askAgain" });
    expect(hostStatusAction({ kind: "revoked" })).toEqual({ action: "forgetAndPair", labelKey: "hosts.expand.forgetAndPair" });
    expect(hostStatusAction({ kind: "error", code: "ERR", message: "m" })).toEqual({ action: "refresh", labelKey: "common.refresh" });
  });
});

describe("getHostDisplayInfo", () => {
  it("maps online status correctly", () => {
    const res = getHostDisplayInfo({ kind: "online" });
    expect(res).toEqual({
      statusTextKey: "hosts.status.online",
      dotStatus: "online",
      isOpenable: true,
      expandable: false,
      action: "none",
    });
  });

  it("maps checking status correctly", () => {
    const res = getHostDisplayInfo({ kind: "checking" });
    expect(res).toEqual({
      statusTextKey: "hosts.status.checking",
      dotStatus: "muted",
      isOpenable: false,
      expandable: false,
      action: "none",
    });
  });

  it("maps offline status correctly", () => {
    const res = getHostDisplayInfo({ kind: "offline" });
    expect(res).toEqual({
      statusTextKey: "hosts.status.offline",
      dotStatus: "offline",
      isOpenable: false,
      expandable: true,
      helpKey: "hosts.expand.offlineHelp",
      action: "refresh",
      actionLabelKey: "common.refresh",
    });
  });

  it("maps revoked status correctly", () => {
    const res = getHostDisplayInfo({ kind: "revoked" });
    expect(res).toEqual({
      statusTextKey: "hosts.status.revoked",
      dotStatus: "error",
      isOpenable: false,
      expandable: true,
      helpKey: "hosts.expand.revokedHelp",
      action: "forgetAndPair",
      actionLabelKey: "hosts.expand.forgetAndPair",
    });
  });

  it("maps unaccepted status with and without strict hint", () => {
    const normal = getHostDisplayInfo({ kind: "unaccepted" });
    expect(normal).toEqual({
      statusTextKey: "hosts.status.unaccepted",
      dotStatus: "offline",
      isOpenable: false,
      expandable: true,
      helpKey: "hosts.expand.unacceptedHelp",
      action: "askAgain",
      actionLabelKey: "hosts.sheet.askAgain",
    });

    const strict = getHostDisplayInfo({ kind: "unaccepted" }, "own-confirmation");
    expect(strict).toEqual({
      statusTextKey: "hosts.unacceptedStrictHint",
      dotStatus: "offline",
      isOpenable: false,
      expandable: true,
      helpKey: "hosts.unacceptedStrictHint",
      action: "askAgain",
      actionLabelKey: "hosts.sheet.askAgain",
    });
  });

  it("maps error status correctly with message", () => {
    const res = getHostDisplayInfo({ kind: "error", code: "NETWORK_ERROR", message: "Network unreachable" });
    expect(res).toEqual({
      statusTextKey: "hosts.status.error",
      statusTextParams: { message: "Network unreachable" },
      dotStatus: "error",
      isOpenable: false,
      expandable: true,
      action: "refresh",
      actionLabelKey: "common.refresh",
    });
  });
});
