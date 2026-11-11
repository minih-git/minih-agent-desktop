import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CORE_PERSONA_TOOLS, type Mode } from "@minih-agent/shared";

export { CORE_PERSONA_TOOLS };

/** Known editing/delegation names stay declared across contract-mode changes. */
const RETAINED_MODE_TOOLS = new Set(["Write", "Edit", "Task", "TaskWait", "TaskList", "TaskStop", "TaskSend"]);

export function retainModeToolDeclaration(name: string): boolean {
  return RETAINED_MODE_TOOLS.has(name);
}

/** The denial an employee definition produces for a tool it does not grant. */
export function personaToolDenial(name: string): string {
  return `${name} is not part of this employee's definition, so it is not available in this session. Dispatch the work to an employee whose definition includes it, or ask the person to change the definition. No action was performed.`;
}

export function modeToolDenial(name: string, mode: Mode): string {
  return `${name} is not allowed in ${mode} mode. No action was performed. Continue read-only inspection and planning with the permitted tools; implementation requires Agent mode or approval of the submitted plan or goal.`;
}

/**
 * Declarations are not grants. Recheck immediately before execution, including
 * references retained from an earlier mode. Throwing here uses pi's existing
 * tool-error channel and the real call id, without inventing transcript items.
 */
export function withModeExecutionGuard(tool: AgentTool, denial: () => string | undefined): AgentTool {
  const currentDenial = denial();
  return {
    ...tool,
    description: currentDenial ? `${tool.description}\n\n${currentDenial}` : tool.description,
    execute: async (...args) => {
      const reason = denial();
      if (reason) throw new Error(reason);
      return tool.execute(...args);
    },
  };
}
