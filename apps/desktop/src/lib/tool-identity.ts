/**
 * The desktop's view of tool identity (see
 * `packages/shared/src/tool-presentation.ts`): whether a row is a skill, an MCP
 * tool, a plugin tool, or a plain tool. A re-export, so the phone and the
 * desktop cannot drift.
 */
export { getToolIdentity, type ToolIdentity } from "@minih-agent/shared";
