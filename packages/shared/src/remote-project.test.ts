/**
 * The opaque remote-project identifier (ADR `local-agent-remote-workspace-tools`).
 *
 * Anything that classifies a session's `projectPath` goes through this module,
 * so the prefix is pinned here once: a value with it names another machine and
 * must never be resolved against a filesystem.
 */
import { describe, expect, it } from "vitest";

import { REMOTE_PROJECT_PATH_PREFIX, isRemoteProjectPath, remoteProjectPath } from "./remote-project.js";

describe("remote project identifiers", () => {
  it("builds the identifier from a host key and a project id", () => {
    expect(remoteProjectPath("ssh:studio", "7")).toBe(`${REMOTE_PROJECT_PATH_PREFIX}["ssh:studio","7"]`);
    expect(isRemoteProjectPath(remoteProjectPath("ssh:studio", "7"))).toBe(true);
  });

  it("recognizes only the opaque form, never a local path", () => {
    expect(isRemoteProjectPath(`${REMOTE_PROJECT_PATH_PREFIX}whatever`)).toBe(true);
    for (const path of ["/Users/minih/Projects/app", "C:\\work\\app", "relative/dir", "", null, undefined]) {
      expect(isRemoteProjectPath(path)).toBe(false);
    }
  });
});
