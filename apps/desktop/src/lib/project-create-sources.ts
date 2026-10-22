/**
 * How the New project dialog presents its sources (rollout R8 package E).
 *
 * Two remote shapes exist and they are **not** the same thing:
 *
 * - an **account computer** runs the Agent itself. Creating a project there
 *   registers the folder on that machine and opens a session whose Agent runs
 *   on that machine (ADR amendment 3, decision 7: the Agent runs where the
 *   project is).
 * - an **SSH host** runs the Agent here and only executes tools there. That flow
 *   predates this release and is unchanged, down to the last byte.
 *
 * The dialog must say which one the user is choosing, because "run on that
 * computer" and "run here, execute tools there" behave differently when the
 * machine goes offline. Keeping the classification here means the component
 * stays layout and the rule is testable on its own.
 */
import type { RemoteHostSummary } from "@minih-agent/shared";

/** The dialog's source options; `account` is the new third remote shape. */
export type ProjectSourceOption = "local" | "git" | "account" | "ssh";

/** Where the Agent will run for a chosen source. */
export type ProjectAgentLocation = "local" | "remote-computer" | "local-with-remote-tools";

/**
 * One folder picked on another computer.
 *
 * Both remote sources answer with the same three facts — which computer, what it
 * is called, and which absolute folder on it — because both feed the same name
 * field. What differs is what pressing create then does with them.
 */
export type RemoteFolderSelection = { hostKey: string; hostLabel: string; path: string };

/** The i18n key that states where the Agent runs, so the difference is visible. */
export function projectAgentLocationKey(source: ProjectSourceOption): string {
  switch (source) {
    case "account":
      return "project.runsOnRemoteComputer";
    case "ssh":
      return "project.runsLocallyWithRemoteTools";
    default:
      return "project.runsOnThisComputer";
  }
}

/** The machine the Agent runs on, for a source. */
export function agentLocationForSource(source: ProjectSourceOption): ProjectAgentLocation {
  switch (source) {
    case "account":
      return "remote-computer";
    case "ssh":
      return "local-with-remote-tools";
    default:
      return "local";
  }
}

/** The label key of one source option. */
export function projectSourceLabelKey(source: ProjectSourceOption): string {
  switch (source) {
    case "account":
      return "project.createSourceAccountComputer";
    case "ssh":
      return "project.createSourceSshHost";
    case "git":
      return "project.createSourceGit";
    default:
      return "project.createComputer";
  }
}

/**
 * Which computers the dialog offers, split by what selecting them means.
 *
 * `git` has no host, and a local folder is always this machine, so only the two
 * remote transports appear here. A record written before the SSH bootstrap
 * existed has no `transport` at all and is an SSH pairing (the type documents
 * `direct` as the default), so it belongs on the SSH side — only an explicit
 * `account` is an account computer. A computer that needs an upgrade is still
 * listed — the page explains why instead of hiding a machine the user knows
 * about — but it cannot be selected, because the operations it needs are the
 * ones it lacks.
 */
export function partitionRemoteHosts(hosts: readonly RemoteHostSummary[]): {
  account: RemoteHostSummary[];
  ssh: RemoteHostSummary[];
} {
  return {
    account: hosts.filter((host) => host.transport === "account"),
    ssh: hosts.filter((host) => host.transport !== "account"),
  };
}

/** Whether a listed computer can be used for a new project right now. */
export function hostUsableForNewProject(host: RemoteHostSummary): boolean {
  return host.connected && host.needsUpgrade === undefined;
}

/**
 * Why a listed computer cannot be used, as an i18n key.
 *
 * `null` means "usable". The order matters: an offline computer is offline
 * whatever its release, and that is the more actionable fact.
 */
export function hostUnusableReasonKey(host: RemoteHostSummary): string | null {
  if (!host.connected) return "project.hostOfflineReason";
  if (host.needsUpgrade) return "project.hostNeedsUpdateReason";
  return null;
}

/**
 * The source the dialog opens on when the caller named a computer.
 *
 * The settings host list has one "new project" action per computer, so the
 * button cannot decide: the computer's transport does. A caller that named no
 * computer starts on this one. Until the host list arrives the named computer is
 * read as an SSH host, which is what it was before this release; the list
 * corrects it as soon as it knows better.
 */
export function initialProjectSource(
  hosts: readonly RemoteHostSummary[],
  initialHostKey: string | undefined,
): ProjectSourceOption {
  if (!initialHostKey) return "local";
  const host = hosts.find((item) => item.hostKey === initialHostKey);
  return host?.transport === "account" ? "account" : "ssh";
}

/**
 * Which account computer the dialog offers first.
 *
 * A named computer wins even when it cannot be used, so the page can explain why
 * instead of quietly offering a different machine. Otherwise the first usable
 * one; if none is usable, the first listed, again so its reason is on screen.
 */
export function defaultAccountHostKey(
  hosts: readonly RemoteHostSummary[],
  preferredHostKey?: string,
): string {
  const account = hosts.filter((host) => host.transport === "account");
  const preferred = account.find((host) => host.hostKey === preferredHostKey);
  if (preferred) return preferred.hostKey;
  return account.find(hostUsableForNewProject)?.hostKey ?? account[0]?.hostKey ?? "";
}
