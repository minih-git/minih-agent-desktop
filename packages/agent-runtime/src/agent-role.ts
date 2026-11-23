/**
 * The role section of a session's system prompt
 * (ADR session-create-model-and-role).
 *
 * `SessionCreate({ agent })` lets the model create a session that acts in one
 * delegate definition's role. The definition's prompt is then appended to that
 * session's system prompt as its own section, on every turn, resolved from the
 * catalog the runtime was launched with.
 *
 * Three properties are deliberate:
 *
 * - **It is a section, not a persona.** Unlike an employee's `botPersona`, a
 *   role narrows nothing: the session keeps its own tool catalog and its own
 *   permission mode, because it is a real conversation the person can take over
 *   mid-flight. The role says what the work is, not what the session may do.
 * - **It is resolved at turn start.** Editing, disabling or deleting the
 *   definition takes effect on the next turn with no relaunch; a definition that
 *   is gone removes the section instead of failing the turn.
 * - **A missing role is reported once.** The session keeps running as the
 *   conversation it is, and the caller sees one diagnostic rather than a turn
 *   that dies over a prompt section.
 */
import type { SubagentDefinition } from "@minih-agent/shared";

export type AgentRoleResolution = {
  /** The section to append, or `undefined` when the role contributes nothing. */
  section?: string;
  /** The handle that no longer names an enabled definition, when that is why. */
  missing?: string;
};

/**
 * Compose one definition's prompt as a role section.
 *
 * The heading is what makes the section readable as a role rather than as more
 * workspace instructions: a delegate's prompt is written in the second person
 * ("You are Explorer — …"), and without the heading it would read as if the
 * person had said it.
 */
export function agentRoleSection(
  definition: Pick<SubagentDefinition, "name" | "prompt">,
): string | undefined {
  const prompt = definition.prompt.trim();
  if (!prompt) return undefined;
  return `## Your role: ${definition.name}\n\n${prompt}`;
}

/**
 * Resolve the stored handle against the definitions this launch offers.
 *
 * `undefined` for a session with no role at all: nothing to add and nothing to
 * report.
 */
export function resolveAgentRole(
  agentName: string | undefined,
  definitions: readonly SubagentDefinition[],
): AgentRoleResolution | undefined {
  const name = agentName?.trim();
  if (!name) return undefined;
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) return { missing: name };
  const section = agentRoleSection(definition);
  return section ? { section } : { missing: name };
}