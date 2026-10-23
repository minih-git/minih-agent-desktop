import type { McpOAuthLoginErrorCode } from "@minih-agent/shared";

type McpOAuthErrorTranslationKey = "extensions.mcp.authDcrUnavailable";

/**
 * Translated recovery guidance for a structured OAuth login failure. Anything
 * outside this list keeps the message main sent, so an unknown failure stays
 * readable instead of collapsing into a generic "authorization failed".
 */
export function mcpOAuthErrorTranslationKey(
  errorCode: McpOAuthLoginErrorCode | undefined,
): McpOAuthErrorTranslationKey | undefined {
  switch (errorCode) {
    case "MCP_OAUTH_DCR_UNAVAILABLE":
      return "extensions.mcp.authDcrUnavailable";
    default:
      return undefined;
  }
}

/**
 * Read the structured code from a rejected login start. A login that fails
 * after start reports the code on the pushed event instead.
 */
export function mcpOAuthErrorCodeOf(error: unknown): McpOAuthLoginErrorCode | undefined {
  const code = (error as { errorCode?: unknown } | null | undefined)?.errorCode;
  if (code === "MCP_OAUTH_DCR_UNAVAILABLE") return code;
  return undefined;
}