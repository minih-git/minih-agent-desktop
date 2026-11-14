import type { BotProfile, SubagentDefinition } from "@minih-agent/shared";

/**
 * Resolve the employee definition a session runs as
 * (ADR bot-sessions-and-steward §2/§9).
 *
 * Three outcomes, and the third one is the point of this function:
 *
 * - an ordinary session has no profile, so nothing changes;
 * - a bot whose definition resolves runs under it;
 * - a bot whose definition **does not** resolve reports `missing`, so the launch
 *   fails instead of quietly running a steward with every tool the session has.
 *   Falling back to "no persona" would turn a typo into a permission bug.
 *
 * `scope` says whose session this is (slice 6). An employee's own session and
 * one of its tasks run the same definition, but only the task keeps the tools
 * its rules are written in terms of (`TaskReport`, `asktool`), so the two are
 * not the same runtime option.
 */
export type BotPersonaScope = "employee" | "task";

export type BotPersonaResolution =
  | { kind: "none" }
  | { kind: "resolved"; definition: SubagentDefinition; scope: BotPersonaScope }
  | { kind: "missing"; name: string };

/** The steward's definition handle: it dispatches, it does not run tasks. */
const STEWARD_DEFINITION = "steward";

export function resolveBotPersona(
  role: string | undefined,
  profile: BotProfile | null | undefined,
  definitions: readonly SubagentDefinition[],
): BotPersonaResolution {
  const name = profile?.definition?.trim();
  if (!name) return { kind: "none" };
  // A profile on a conversation would be an identity nothing reads, so it is
  // not a persona either.
  if (role !== "bot") return { kind: "none" };
  const definition = definitions.find((candidate) => candidate.name === name);
  return definition
    ? { kind: "resolved", definition, scope: "employee" }
    : { kind: "missing", name };
}

/**
 * The persona of a **task** session: the definition of the employee it belongs
 * to (employee mode 0.5 slice 6).
 *
 * The profile is the employee's, not the task's — a task has none of its own.
 * Two rules are specific to this scope:
 *
 * - `steward` is not a role a task can run as: the steward dispatches work, and
 *   does not hand it to herself;
 * - an employee that names no definition keeps today's behaviour, which is a
 *   task with every tool the session has.
 */
export function resolveTaskPersona(
  employee: BotProfile | null | undefined,
  definitions: readonly SubagentDefinition[],
): BotPersonaResolution {
  const name = employee?.definition?.trim();
  if (!name || name === STEWARD_DEFINITION) return { kind: "none" };
  const definition = definitions.find((candidate) => candidate.name === name);
  return definition
    ? { kind: "resolved", definition, scope: "task" }
    : { kind: "missing", name };
}

/** The value the runtime expects for `botPersona`, or undefined for none. */
export function runtimeBotPersona(
  resolution: BotPersonaResolution,
):
  | { definition: SubagentDefinition; taskSession?: boolean }
  | { missingName: string }
  | undefined {
  if (resolution.kind === "resolved") {
    return resolution.scope === "task"
      ? { definition: resolution.definition, taskSession: true }
      : { definition: resolution.definition };
  }
  if (resolution.kind === "missing") return { missingName: resolution.name };
  return undefined;
}