import { describe, expect, it } from "vitest";

import {
  MAX_BOT_DUTY_CHARS,
  MAX_BOT_NAME_CHARS,
  MAX_MANDATE_BOUNDARIES,
  MAX_MANDATE_BOUNDARY_CHARS,
  MAX_MANDATE_CRITERIA,
  MAX_MANDATE_CRITERION_TEXT_CHARS,
  MAX_MANDATE_GOAL_CHARS,
  MAX_MANDATE_SOURCE_UTTERANCE_CHARS,
  decodeMandate,
  encodeMandate,
  isSessionRole,
  mandateCeiling,
  narrowPermission,
  normalizeBotProfile,
  normalizeRepoOrigin,
  parseMandate,
  stageNeedsPerson,
  unionMustAsk,
  type Mandate,
} from "./bot-session.js";

const base = (overrides: Partial<Mandate> = {}): Mandate => ({
  version: 1,
  taskId: "task-1",
  goal: "Fix the login timeout",
  criteria: [{ id: "c1", text: "A failing repro exists" }],
  boundaries: ["Do not touch billing"],
  permissionMode: "accept-edits",
  mustAsk: ["push"],
  risk: "medium",
  requestedBy: { kind: "user", hostId: "mac-mini" },
  sourceUtterance: "login 超时今天修掉",
  createdAt: "2026-11-10T09:00:00.000Z",
  policyVersion: "steward-1",
  ...overrides,
});

describe("decodeMandate", () => {
  it("accepts a complete mandate and keeps every field", () => {
    const result = decodeMandate(base({ repo: { origin: "git@github.com:Minih/Desktop.git" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mandate.repo?.origin).toBe("github.com/Minih/Desktop");
    expect(result.mandate.taskId).toBe("task-1");
    // The always-asked actions are unioned in, never trusted from the card.
    expect(result.mandate.mustAsk).toEqual(["push", "deploy", "delete", "spend"]);
  });

  it("refuses a version it does not know instead of reinterpreting it", () => {
    const result = decodeMandate({ ...base(), version: 2 });
    expect(result.ok).toBe(false);
  });

  it("refuses an empty criteria list, duplicate ids, and over-long lists", () => {
    expect(decodeMandate(base({ criteria: [] })).ok).toBe(false);
    expect(
      decodeMandate(
        base({
          criteria: [
            { id: "c1", text: "one" },
            { id: "c1", text: "two" },
          ],
        }),
      ).ok,
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_MANDATE_CRITERIA + 1 }, (_, index) => ({
      id: `c${index}`,
      text: `criterion ${index}`,
    }));
    expect(decodeMandate(base({ criteria: tooMany })).ok).toBe(false);
    expect(
      decodeMandate(base({ criteria: tooMany.slice(0, MAX_MANDATE_CRITERIA) })).ok,
    ).toBe(true);
  });

  it("bounds boundaries, the goal, and the source utterance", () => {
    const tooMany = Array.from({ length: MAX_MANDATE_BOUNDARIES + 1 }, (_, index) => `b${index}`);
    expect(decodeMandate(base({ boundaries: tooMany })).ok).toBe(false);
    // Over-long text is bounded, not refused: the card the person confirmed is
    // still the card, truncated at a known limit.
    const longGoal = decodeMandate(base({ goal: "x".repeat(MAX_MANDATE_GOAL_CHARS + 50) }));
    expect(longGoal.ok).toBe(true);
    if (longGoal.ok) {
      expect(longGoal.mandate.goal).toHaveLength(MAX_MANDATE_GOAL_CHARS);
    }
    const longWords = decodeMandate(
      base({ sourceUtterance: "y".repeat(MAX_MANDATE_SOURCE_UTTERANCE_CHARS + 50) }),
    );
    expect(longWords.ok).toBe(true);
    if (longWords.ok) {
      expect(longWords.mandate.sourceUtterance).toHaveLength(MAX_MANDATE_SOURCE_UTTERANCE_CHARS);
    }
  });

  it("refuses a missing requester, a non-user requester, and a non-timestamp creation", () => {
    expect(decodeMandate({ ...base(), requestedBy: undefined }).ok).toBe(false);
    expect(decodeMandate(base({ requestedBy: { kind: "bot", hostId: "h" } as never })).ok).toBe(
      false,
    );
    expect(decodeMandate(base({ createdAt: "yesterday" })).ok).toBe(false);
  });

  it("refuses an unknown mustAsk action and an unrecognizable repo", () => {
    expect(decodeMandate(base({ mustAsk: ["push", "publish"] as never })).ok).toBe(false);
    expect(decodeMandate(base({ repo: { origin: "not a remote" } })).ok).toBe(false);
  });

  it("round-trips through encode and parse, and never repairs malformed JSON", () => {
    const encoded = encodeMandate(base());
    const parsed = parseMandate(encoded);
    expect(parsed.ok).toBe(true);
    expect(parseMandate("{").ok).toBe(false);
    expect(parseMandate("").ok).toBe(false);
    expect(parseMandate(undefined).ok).toBe(false);
  });

  it("refuses a mandate whose encoded form exceeds its storage bound", () => {
    // The encoded size is its own limit: a card can satisfy every per-field
    // character bound and still be too large to store.
    const criteria = Array.from({ length: MAX_MANDATE_CRITERIA }, (_, index) => ({
      id: `criterion-${index}`,
      text: "a".repeat(MAX_MANDATE_CRITERION_TEXT_CHARS),
    }));
    const boundaries = Array.from({ length: MAX_MANDATE_BOUNDARIES }, () =>
      "b".repeat(MAX_MANDATE_BOUNDARY_CHARS),
    );
    const fit = {
      goal: "g".repeat(MAX_MANDATE_GOAL_CHARS),
      sourceUtterance: "s".repeat(MAX_MANDATE_SOURCE_UTTERANCE_CHARS),
    };
    // A plain card at every bound is well under the encoded limit, so an
    // ordinary task is never refused on size.
    expect(
      decodeMandate(
        base({
          criteria,
          boundaries,
          ...fit,
        }),
      ).ok,
    ).toBe(true);
    // CJK text costs three UTF-8 bytes per character, so the same bounds do not
    // fit once encoded even though each of them is satisfied.
    const result = decodeMandate(
      base({
        criteria: criteria.map((row) => ({ id: row.id, text: "验".repeat(500) })),
        boundaries: boundaries.map(() => "界".repeat(300)),
        goal: "目".repeat(2_048),
        sourceUtterance: "话".repeat(1_500),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("bytes");
    }
  });
});

describe("permission narrowing", () => {
  it("never widens past either side and ignores inherit as a capability", () => {
    expect(narrowPermission("auto", "ask")).toBe("ask");
    expect(narrowPermission("accept-edits", "auto")).toBe("accept-edits");
    expect(narrowPermission("inherit", "accept-edits")).toBe("accept-edits");
    expect(narrowPermission("inherit", undefined)).toBe("inherit");
    expect(narrowPermission(null, "ask")).toBe("ask");
  });

  it("takes the minimum of the card, the source ceiling, and the bot ceiling", () => {
    expect(
      mandateCeiling({
        mandate: { permissionMode: "auto" },
        sourceCeiling: "accept-edits",
        botCeiling: "auto",
      }),
    ).toBe("accept-edits");
    // A card can be narrower than the ceilings, which is its only power.
    expect(
      mandateCeiling({
        mandate: { permissionMode: "ask" },
        sourceCeiling: "auto",
        botCeiling: "auto",
      }),
    ).toBe("ask");
    // A card cannot widen authority on its own.
    expect(mandateCeiling({ mandate: { permissionMode: "auto" }, botCeiling: "ask" })).toBe("ask");
    expect(mandateCeiling({ sourceCeiling: "auto", botCeiling: "accept-edits" })).toBe(
      "accept-edits",
    );
  });
});

describe("bot profile", () => {
  it("defaults observe on and keeps the irrevocable asks", () => {
    const profile = normalizeBotProfile({ name: "小爪", permissionMode: "auto" });
    expect(profile).not.toBeNull();
    expect(profile?.observe).toBe(true);
    expect(profile?.mustAsk).toEqual(["deploy", "delete", "spend"]);
  });

  it("keeps an explicit observe:false and drops unknown ask actions", () => {
    const profile = normalizeBotProfile({
      name: "小爪",
      permissionMode: "accept-edits",
      observe: false,
      mustAsk: ["push", "publish"],
      homeHostId: "mac-mini",
    });
    expect(profile?.observe).toBe(false);
    expect(profile?.mustAsk).toEqual(["push", "deploy", "delete", "spend"]);
    expect(profile?.homeHostId).toBe("mac-mini");
  });

  it("refuses a profile without a name or permission mode", () => {
    expect(normalizeBotProfile({ permissionMode: "auto" })).toBeNull();
    expect(normalizeBotProfile({ name: "   ", permissionMode: "auto" })).toBeNull();
    expect(normalizeBotProfile({ name: "bot" })).toBeNull();
    expect(normalizeBotProfile(null)).toBeNull();
  });

  it("bounds the profile text fields", () => {
    const profile = normalizeBotProfile({
      name: "n".repeat(MAX_BOT_NAME_CHARS + 10),
      duty: "d".repeat(MAX_BOT_DUTY_CHARS + 10),
      permissionMode: "ask",
    });
    expect(profile?.name).toHaveLength(MAX_BOT_NAME_CHARS);
    expect(profile?.duty).toHaveLength(MAX_BOT_DUTY_CHARS);
  });

  it("refuses a home host id that is not a plain identifier", () => {
    expect(
      normalizeBotProfile({ name: "bot", permissionMode: "ask", homeHostId: "a b" })?.homeHostId,
    ).toBeUndefined();
  });
});

describe("vocabulary", () => {
  it("disturbs the person only for person-owned stages", () => {
    expect(stageNeedsPerson("person/answer")).toBe(true);
    expect(stageNeedsPerson("person/accept")).toBe(true);
    expect(stageNeedsPerson("working")).toBe(false);
    expect(stageNeedsPerson("blocked")).toBe(false);
    expect(stageNeedsPerson(null)).toBe(false);
  });

  it("unions must-ask lists without duplicates", () => {
    expect(unionMustAsk(["push"], ["push", "merge"])).toEqual([
      "push",
      "merge",
      "deploy",
      "delete",
      "spend",
    ]);
    expect(unionMustAsk()).toEqual(["deploy", "delete", "spend"]);
  });

  it("recognizes exactly the two session roles", () => {
    expect(isSessionRole("bot")).toBe(true);
    expect(isSessionRole("user")).toBe(true);
    expect(isSessionRole("steward")).toBe(false);
  });
});

describe("normalizeRepoOrigin", () => {
  it("reduces ssh, scp-style, and https remotes to one identity", () => {
    expect(normalizeRepoOrigin("git@github.com:Minih/Minih-Agent-Desktop.git")).toBe(
      "github.com/Minih/Minih-Agent-Desktop",
    );
    expect(normalizeRepoOrigin("ssh://git@github.com/Minih/Minih-Agent-Desktop")).toBe(
      "github.com/Minih/Minih-Agent-Desktop",
    );
    expect(normalizeRepoOrigin("https://GitHub.com/Minih/Minih-Agent-Desktop.git/")).toBe(
      "github.com/Minih/Minih-Agent-Desktop",
    );
    // Only the host folds case: `minih-router` and `MiniH-Router` are two
    // different repositories and must not collapse into one identity.
    expect(normalizeRepoOrigin("git@GitHub.com:minih/MiniH-Router.git")).toBe(
      "github.com/minih/MiniH-Router",
    );
    expect(normalizeRepoOrigin("git@github.com:minih/MiniH-Router.git")).not.toBe(
      normalizeRepoOrigin("https://github.com/minih/minih-router"),
    );
  });

  it("refuses something that is not a remote", () => {
    expect(normalizeRepoOrigin("")).toBeUndefined();
    expect(normalizeRepoOrigin("github.com/owner")).toBeUndefined();
    expect(normalizeRepoOrigin(undefined)).toBeUndefined();
  });
});
