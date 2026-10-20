/**
 * How a Host path is shown on the phone (rollout A2).
 *
 * The Host answers with absolute paths under the user's home directory. Printing
 * those verbatim would put the account name on a phone screen and overflow it,
 * so the display form starts at the browse root. The request always keeps the
 * Host's own spelling.
 */
import { describe, expect, it } from "vitest";

import { displayEntry, displayPath } from "./path-display.js";

describe("displayPath", () => {
  const root = "/home/minih";

  it("shows a path under the root from the root", () => {
    expect(displayPath("/home/minih/Projects/app", root)).toBe("~/Projects/app");
  });

  it("shows the root itself as ~", () => {
    expect(displayPath(root, root)).toBe("~");
  });

  it("leaves a path outside the root alone", () => {
    // The Host never lists one, but a stale entry from another build must not be
    // silently rewritten into something that looks like it is inside.
    expect(displayPath("/srv/data", root)).toBe("/srv/data");
  });

  it("does not treat a sibling with the same prefix as inside", () => {
    expect(displayPath("/home/minih2/app", root)).toBe("/home/minih2/app");
  });

  it("tolerates a trailing separator on the root and an unknown root", () => {
    expect(displayPath("/home/minih/Projects", "/home/minih/")).toBe("~/Projects");
    expect(displayPath("/home/minih/Projects", null)).toBe("/home/minih/Projects");
    expect(displayPath("/home/minih/Projects", "")).toBe("/home/minih/Projects");
  });

  it("rewrites an entry the same way", () => {
    expect(displayEntry({ name: "app", path: "/home/minih/Projects/app" }, root)).toEqual({
      name: "app",
      path: "~/Projects/app",
    });
  });
});
