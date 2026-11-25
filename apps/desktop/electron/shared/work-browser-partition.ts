/**
 * The Chromium partition the work-panel browser and the Agent `Browser` tool
 * share (D100, ADR 0019).
 *
 * It lives in its own dependency-free module so the pane can import it without
 * pulling in proxy routing (which needs Electron and the agent runtime), and so
 * the routing table and the pane cannot drift onto different partitions.
 */
export const WORK_BROWSER_PARTITION = "persist:work-browser";