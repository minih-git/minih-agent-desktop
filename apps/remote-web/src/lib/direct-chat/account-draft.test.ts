import { describe, expect, it } from "vitest";

import { readAccountDraft } from "./account-draft.js";

const scope = { gatewayRoot: "https://router.example", accessKeyId: "key-1" };

describe("reading the draft a new conversation opens with", () => {
  it("returns the saved draft", async () => {
    const history = { accountDraft: async () => "half a sentence" };
    await expect(readAccountDraft(history, scope)).resolves.toBe("half a sentence");
  });

  it("starts empty when there is no account scope, without reading", async () => {
    let reads = 0;
    const history = {
      accountDraft: async () => {
        reads += 1;
        return "unused";
      },
    };
    await expect(readAccountDraft(history, null)).resolves.toBe("");
    expect(reads).toBe(0);
  });

  it("starts empty and reports the reason when the local read fails", async () => {
    const warnings: unknown[] = [];
    const history = {
      accountDraft: async (): Promise<string> => {
        throw new Error("NotFoundError: drafts");
      },
    };
    await expect(
      readAccountDraft(history, scope, (_message, detail) => warnings.push(detail)),
    ).resolves.toBe("");
    expect(warnings).toEqual(["NotFoundError: drafts"]);
  });
});
