/**
 * How a *Host's* absolute path is recognized (D670 amendment, rollout R7).
 *
 * The rules used to be "starts with `/`" in four places — the desktop's browse
 * validation, two IPC handlers, and the folder picker's buttons — so a Windows
 * Host's `C:\Users\me` answer was refused as malformed and the picker showed
 * nothing. These cases pin both directions of the fix: a Windows answer is well
 * formed, and a malformed one is still refused.
 */
import { describe, expect, it } from "vitest";

import {
  REMOTE_PATH_MAX_LENGTH,
  isAbsoluteRemotePath,
  isRemoteChildPath,
  isRemoteEntryName,
  remoteChildPaths,
  remotePathSeparator,
  shortenRemoteHomePath,
} from "./remote-path.js";

describe("isAbsoluteRemotePath", () => {
  it("accepts a POSIX absolute path", () => {
    expect(isAbsoluteRemotePath("/")).toBe(true);
    expect(isAbsoluteRemotePath("/home/minih/Projects/app")).toBe(true);
  });

  it("accepts a Windows drive path in either separator", () => {
    expect(isAbsoluteRemotePath("C:\\Users\\minih")).toBe(true);
    expect(isAbsoluteRemotePath("C:/Users/minih")).toBe(true);
    expect(isAbsoluteRemotePath("c:\\Users")).toBe(true);
    expect(isAbsoluteRemotePath("D:\\")).toBe(true);
  });

  it("accepts a UNC share and the extended-length form", () => {
    expect(isAbsoluteRemotePath("\\\\build-server\\shared\\app")).toBe(true);
    expect(isAbsoluteRemotePath("\\\\?\\C:\\Users\\minih")).toBe(true);
  });

  it("refuses relative, drive-relative and root-relative paths", () => {
    for (const value of ["", "home/minih", "./app", "..", "..\\app", "C:app", "C:", "\\Users", "%TEMP%\\app"]) {
      expect(isAbsoluteRemotePath(value), value).toBe(false);
    }
  });

  it("refuses anything that is not a bounded control-character-free string", () => {
    expect(isAbsoluteRemotePath(null)).toBe(false);
    expect(isAbsoluteRemotePath(undefined)).toBe(false);
    expect(isAbsoluteRemotePath(7)).toBe(false);
    expect(isAbsoluteRemotePath("/home/\u0000etc")).toBe(false);
    expect(isAbsoluteRemotePath("/home/\n")).toBe(false);
    expect(isAbsoluteRemotePath(`/${"a".repeat(REMOTE_PATH_MAX_LENGTH)}`)).toBe(false);
    expect(isAbsoluteRemotePath(`/${"a".repeat(REMOTE_PATH_MAX_LENGTH - 1)}`)).toBe(true);
  });
});

describe("remotePathSeparator", () => {
  it("reports the separator the Host actually used", () => {
    expect(remotePathSeparator("/home/minih")).toBe("/");
    expect(remotePathSeparator("C:\\Users\\minih")).toBe("\\");
    expect(remotePathSeparator("C:\\")).toBe("\\");
    // A POSIX directory name may legitimately contain a backslash.
    expect(remotePathSeparator("/home/we\\ird")).toBe("/");
  });
});

describe("isRemoteChildPath", () => {
  it("joins with the POSIX separator, including at the root", () => {
    expect(isRemoteChildPath("/home/minih", "app", "/home/minih/app")).toBe(true);
    expect(isRemoteChildPath("/", "root", "/root")).toBe(true);
  });

  it("joins with the Windows separator, including at a drive root", () => {
    expect(isRemoteChildPath("C:\\Users\\minih", "app", "C:\\Users\\minih\\app")).toBe(true);
    expect(isRemoteChildPath("C:\\", "Users", "C:\\Users")).toBe(true);
    expect(isRemoteChildPath("\\\\server\\share", "app", "\\\\server\\share\\app")).toBe(true);
  });

  it("accepts either joining separator, but not a respelled parent", () => {
    // Windows accepts `/` and `\` between components, so a Host may answer with
    // either. The parent's own spelling must still match exactly.
    expect(isRemoteChildPath("C:\\Users\\minih", "app", "C:\\Users\\minih/app")).toBe(true);
    expect(isRemoteChildPath("C:/Users/minih", "app", "C:/Users/minih\\app")).toBe(true);
    expect(isRemoteChildPath("C:\\Users\\minih", "app", "C:/Users/minih/app")).toBe(false);
  });

  it("refuses a sibling, a parent, a nested path, and a renamed entry", () => {
    expect(isRemoteChildPath("/home/minih", "app", "/home/minih2/app")).toBe(false);
    expect(isRemoteChildPath("/home/minih", "app", "/home/minih")).toBe(false);
    expect(isRemoteChildPath("/home/minih", "app", "/home/minih/app/src")).toBe(false);
    expect(isRemoteChildPath("/home/minih", "app", "/home/minih/other")).toBe(false);
    expect(isRemoteChildPath("C:\\Users\\minih", "app", "C:\\Users\\other\\app")).toBe(false);
  });

  it("builds both spellings for one directory", () => {
    expect(remoteChildPaths("/home/minih", "app")).toEqual(["/home/minih/app", "/home/minih\\app"]);
    expect(remoteChildPaths("C:\\Users\\minih\\", "app")).toEqual(["C:\\Users\\minih/app", "C:\\Users\\minih\\app"]);
  });
});

describe("isRemoteEntryName", () => {
  it("refuses a separator of the Host's own style", () => {
    expect(isRemoteEntryName("app/src", "/home/minih")).toBe(false);
    expect(isRemoteEntryName("app\\src", "C:\\Users\\minih")).toBe(false);
    // Windows forbids `/` in a name as well.
    expect(isRemoteEntryName("app/src", "C:\\Users\\minih")).toBe(false);
  });

  it("keeps a backslash that is legal on a POSIX Host", () => {
    // Refusing it would fail a whole listing over one directory POSIX allows.
    expect(isRemoteEntryName("we\\ird", "/home/minih")).toBe(true);
  });

  it("refuses dot entries, empty names, control characters and oversized names", () => {
    for (const name of [".", "..", "", "a\u0000b", "a\nb", null, 7, "a".repeat(4097)]) {
      expect(isRemoteEntryName(name, "/home/minih"), String(name)).toBe(false);
    }
    expect(isRemoteEntryName("a".repeat(4096), "/home/minih")).toBe(true);
  });
});

describe("shortenRemoteHomePath", () => {
  it("shortens a POSIX path under the root", () => {
    expect(shortenRemoteHomePath("/home/minih", "/home/minih")).toBe("~");
    expect(shortenRemoteHomePath("/home/minih/Projects/app", "/home/minih")).toBe("~/Projects/app");
    expect(shortenRemoteHomePath("/home/minih/Projects/app", "/home/minih/")).toBe("~/Projects/app");
  });

  it("shortens a Windows path under the root with that Host's separator", () => {
    expect(shortenRemoteHomePath("C:\\Users\\minih", "C:\\Users\\minih")).toBe("~");
    expect(shortenRemoteHomePath("C:\\Users\\minih\\Projects\\app", "C:\\Users\\minih")).toBe("~\\Projects\\app");
    expect(shortenRemoteHomePath("C:\\Users\\minih\\Projects", "C:\\Users\\minih\\")).toBe("~\\Projects");
    expect(shortenRemoteHomePath("C:\\Users", "C:\\")).toBe("~\\Users");
  });

  it("leaves a path outside the root, a sibling and a missing root alone", () => {
    expect(shortenRemoteHomePath("/srv/data", "/home/minih")).toBe("/srv/data");
    expect(shortenRemoteHomePath("/home/minih2/app", "/home/minih")).toBe("/home/minih2/app");
    expect(shortenRemoteHomePath("C:\\Users\\minih2\\app", "C:\\Users\\minih")).toBe("C:\\Users\\minih2\\app");
    expect(shortenRemoteHomePath("/home/minih/app", "")).toBe("/home/minih/app");
  });
});