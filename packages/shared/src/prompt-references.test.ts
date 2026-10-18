import { describe, expect, it } from "vitest";
import {
  findPromptReferenceTokens,
  promptReferenceFileNames,
  promptTextWithoutReferences,
} from "./prompt-references.js";

describe("prompt reference tokens", () => {
  it("finds absolute and quoted references a pasted chip serializes to", () => {
    const tokens = findPromptReferenceTokens(
      'fix @/Users/x/.minih/scratch/s1/pasted/pasted-ab.txt then @"C:/notes/a b.md"',
    );
    expect(tokens.map((token) => token.path)).toEqual([
      "/Users/x/.minih/scratch/s1/pasted/pasted-ab.txt",
      "C:/notes/a b.md",
    ]);
    expect(tokens[0].start).toBe(4);
  });

  it("keeps prose words and links that are not references", () => {
    expect(findPromptReferenceTokens("explain @media queries and @team")).toEqual([]);
    expect(findPromptReferenceTokens("see minih-agent-desktop://session/abc")).toEqual([]);
  });

  it("drops trailing sentence marks from an unquoted path", () => {
    expect(findPromptReferenceTokens("read @src/a.ts, then explain").map((token) => token.path)).toEqual([
      "src/a.ts",
    ]);
  });

  it("returns the user's own words without the reference paths", () => {
    expect(
      promptTextWithoutReferences(
        "@/Users/x/scratch/s1/pasted/pasted-ab.txt\n请帮我总结这份需求文档  \n",
      ),
    ).toBe("请帮我总结这份需求文档");
    expect(promptTextWithoutReferences('@"a b/c.md" compare @src/d.ts and ship')).toBe("compare and ship");
  });

  it("returns an empty string when the prompt is only references", () => {
    expect(promptTextWithoutReferences("@/tmp/pasted/pasted-ab.txt")).toBe("");
    expect(promptTextWithoutReferences("")).toBe("");
  });
});

describe("prompt reference file names", () => {
  it("names the workspace files a reference-only prompt points at", () => {
    expect(promptReferenceFileNames("@src/login.ts")).toEqual(["login.ts"]);
    expect(promptReferenceFileNames('@src/a.ts @"C:/notes/b c.md" @src/a.ts')).toEqual([
      "a.ts",
      "b c.md",
    ]);
  });

  it("leaves pasted scratch chips out and bounds the list", () => {
    expect(
      promptReferenceFileNames(
        "@/data/scratch/s1/pasted/pasted-a1b2.txt @src/login.ts",
      ),
    ).toEqual(["login.ts"]);
    const many = Array.from({ length: 10 }, (_, index) => `@src/file-${index}.ts`).join(" ");
    expect(promptReferenceFileNames(many)).toHaveLength(6);
    expect(promptReferenceFileNames(`@src/${"x".repeat(200)}.ts`)[0].length).toBeLessThanOrEqual(60);
  });
});
