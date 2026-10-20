import type { HostStatusView } from "../hooks/useHostStatus.js";
import { unacceptedNextStep, type HostRegistryEntry, type UnacceptedNextStep } from "./host-registry.js";
import type { StatusType } from "../components/ui/StatusDot.js";

export type HostDisplayStatusKind = HostStatusView["kind"];

export interface HostDisplayInfo {
  statusTextKey: string;
  statusTextParams?: Record<string, string>;
  dotStatus: StatusType;
  isOpenable: boolean;
  expandable: boolean;
  helpKey?: string;
  action?: "refresh" | "askAgain" | "forgetAndPair" | "none";
  actionLabelKey?: string;
}

export function hostDotStatus(status: HostStatusView): StatusType {
  switch (status.kind) {
    case "online":
      return "online";
    case "checking":
      return "muted";
    case "offline":
      return "offline";
    case "revoked":
    case "error":
      return "error";
    case "unaccepted":
      return "offline";
    default:
      return "muted";
  }
}

export function formatHostStatusLine(
  status: HostStatusView,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (status.kind) {
    case "online":
      return t("hosts.status.online");
    case "checking":
      return t("hosts.status.checking");
    case "offline":
      return t("hosts.status.offline");
    case "revoked":
      return t("hosts.status.revoked");
    case "unaccepted":
      return t("hosts.status.unaccepted");
    case "error":
      return t("hosts.status.error");
    default:
      return t("hosts.status.checking");
  }
}

export function formatHostStatusHelp(
  status: HostStatusView,
  entry: HostRegistryEntry,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  switch (status.kind) {
    case "offline":
      return t("hosts.expand.offlineHelp");
    case "unaccepted":
      if (unacceptedNextStep(entry) === "own-confirmation") {
        return t("hosts.unacceptedStrictHint");
      }
      return t("hosts.expand.unacceptedHelp");
    case "revoked":
      return t("hosts.expand.revokedHelp");
    case "error":
      return status.message ? status.message : t("hosts.expand.offlineHelp");
    case "online":
    case "checking":
    default:
      return null;
  }
}

export interface HostActionResolution {
  action: "refresh" | "askAgain" | "forgetAndPair" | "none";
  labelKey: string;
}

export function hostStatusAction(
  status: HostStatusView,
  _entry?: HostRegistryEntry,
): HostActionResolution {
  switch (status.kind) {
    case "offline":
    case "error":
      return { action: "refresh", labelKey: "common.refresh" };
    case "unaccepted":
      return { action: "askAgain", labelKey: "hosts.sheet.askAgain" };
    case "revoked":
      return { action: "forgetAndPair", labelKey: "hosts.expand.forgetAndPair" };
    case "online":
    case "checking":
    default:
      return { action: "none", labelKey: "" };
  }
}

export function getHostDisplayInfo(
  status: HostStatusView,
  unacceptedStep?: UnacceptedNextStep,
): HostDisplayInfo {
  const dotStatus = hostDotStatus(status);
  const actionRes = hostStatusAction(status);

  switch (status.kind) {
    case "online":
      return {
        statusTextKey: "hosts.status.online",
        dotStatus,
        isOpenable: true,
        expandable: false,
        action: "none",
      };
    case "checking":
      return {
        statusTextKey: "hosts.status.checking",
        dotStatus,
        isOpenable: false,
        expandable: false,
        action: "none",
      };
    case "offline":
      return {
        statusTextKey: "hosts.status.offline",
        dotStatus,
        isOpenable: false,
        expandable: true,
        helpKey: "hosts.expand.offlineHelp",
        action: actionRes.action,
        actionLabelKey: actionRes.labelKey,
      };
    case "revoked":
      return {
        statusTextKey: "hosts.status.revoked",
        dotStatus,
        isOpenable: false,
        expandable: true,
        helpKey: "hosts.expand.revokedHelp",
        action: actionRes.action,
        actionLabelKey: actionRes.labelKey,
      };
    case "unaccepted":
      return {
        statusTextKey:
          unacceptedStep === "own-confirmation"
            ? "hosts.unacceptedStrictHint"
            : "hosts.status.unaccepted",
        dotStatus,
        isOpenable: false,
        expandable: true,
        helpKey:
          unacceptedStep === "own-confirmation"
            ? "hosts.unacceptedStrictHint"
            : "hosts.expand.unacceptedHelp",
        action: actionRes.action,
        actionLabelKey: actionRes.labelKey,
      };
    case "error":
      return {
        statusTextKey: "hosts.status.error",
        statusTextParams: { message: status.message },
        dotStatus,
        isOpenable: false,
        expandable: true,
        action: actionRes.action,
        actionLabelKey: actionRes.labelKey,
      };
    default:
      return {
        statusTextKey: "hosts.status.checking",
        dotStatus: "muted",
        isOpenable: false,
        expandable: false,
        action: "none",
      };
  }
}
