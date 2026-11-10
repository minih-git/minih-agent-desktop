import type { BotProfile, SubagentDefinition } from "@minih-agent/shared";

/**
 * Resolve the employee definition a bot session runs as
 * (ADR bot-sessions-and-steward §2).
 *
 * Three outcomes, and the third one is the point of this function:
 *
 * - an ordinary session has no profile, so nothing changes;
 * - a bot whose definition resolves runs under it;
 * - a bot whose definition **does not** resolve reports `missing`, so the launch
 *   fails instead of quietly running a steward with every tool the session has.
 *   Falling back to "no persona" would turn a typo into a permission bug.
 */
export type BotPersonaResolution =
  | { kind: "none" }
  | { kind: "resolved"; definition: SubagentDefinition }
  | { kind: "missing"; name: string };

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
  return definition ? { kind: "resolved", definition } : { kind: "missing", name };
}

/** The value the runtime expects for `botPersona`, or undefined for none. */
export function runtimeBotPersona(
  resolution: BotPersonaResolution,
): { definition: SubagentDefinition } | { missingName: string } | undefined {
  if (resolution.kind === "resolved") return { definition: resolution.definition };
  if (resolution.kind === "missing") return { missingName: resolution.name };
  return undefined;
}
