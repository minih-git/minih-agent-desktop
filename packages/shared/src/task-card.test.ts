import { describe, expect, it } from "vitest";

import {
  MAX_MANDATE_CRITERIA,
  mandateCeiling,
  type Mandate,
} from "./bot-session.js";
import {
  confirmTaskCard,
  describeTaskCard,
  freezeTaskCard,
  normalizeTaskCard,
  type DraftedCard,
  type TaskCardDraft,
} from "./task-card.js";

const draft = (overrides: Partial<TaskCardDraft> = {}): TaskCardDraft => ({
  goal: "Fix the login timeout",
  criteria: [{ text: "A failing repro exists" }, { text: "The fix has a test" }],
  boundaries: ["Do not touch billing"],
  permissionMode: "accept-edits",
  mustAsk: ["push"],
  // Why this employee (employee mode 0.5 slice 3). Required on every card.
  reason: "The task is pages and interaction; you mentioned Desktop; it is idle.",
  ...overrides,
});

const freeze = (card: TaskCardDraft, overrides: Record<string, unknown> = {}) => {
  const normalized = normalizeTaskCard(card);
  if (!normalized.ok) throw new Error(`draft refused: ${normalized.message}`);
  return freezeTaskCard({
    card: normalized.card,
    taskId: "task-1",
    sourceUtterance: "登录超时今天修掉",
    requestedBy: { hostId: "mac-mini" },
    createdAt: "2026-11-10T09:00:00.000Z",
    policyVersion: "steward-1",
    ...overrides,
  });
};

/**
 * 0-c's contract: a card asks for permission and never grants it.
 *
 * These are the refusals and merges that make that true. If one of them stops
 * holding, a proposal can start behaving like an authorization, so each case
 * asserts the specific refusal rather than a generic failure.
 */
describe("a card never carries authority nobody chose", () => {
  it("refuses a card that does not say why it names this employee", () => {
    // Slice 3: a card names a person, and the person confirming it has to be
    // able to read why. A missing reason is a refusal, not an empty line.
    const result = normalizeTaskCard(draft({ reason: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("reason");
  });

  it("keeps the reason on the card and out of the frozen mandate", () => {
    const normalized = normalizeTaskCard(draft());
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.card.reason).toBe(
      "The task is pages and interaction; you mentioned Desktop; it is idle.",
    );
    // The reason explains a choice; it never authorizes anything, so it is not
    // part of what a confirmation freezes.
    const frozen = freeze(draft());
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(JSON.stringify(frozen.mandate)).not.toContain("why it names this employee");
    expect(Object.keys(frozen.mandate)).not.toContain("reason");
  });

  it("refuses a card with no permission mode instead of defaulting one", () => {
    const result = normalizeTaskCard(draft({ permissionMode: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("permission-mode");
  });

  it("refuses `inherit`, which is a deferral and not a permission", () => {
    const result = normalizeTaskCard(draft({ permissionMode: "inherit" as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("permission-mode");
  });
  it("only lets a card call itself read-only when it asks before acting", () => {
    // `auto` is the widest mode the product has, not a safe one: the label and
    // the mode cannot disagree (review S1).
    const wide = normalizeTaskCard(draft({ permissionMode: "auto", readOnly: true }));
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.error).toBe("read-only");
    const edits = normalizeTaskCard(draft({ permissionMode: "accept-edits", readOnly: true }));
    expect(edits.ok).toBe(false);
    // The one combination that is read-only, and it is stated rather than
    // inferred: a card that never mentions the field is not read-only.
    const readOnly = normalizeTaskCard(draft({ permissionMode: "ask", readOnly: true }));
    expect(readOnly.ok).toBe(true);
    if (readOnly.ok) expect(readOnly.card.readOnly).toBe(true);
    expect(normalizeTaskCard(draft({ permissionMode: "ask" })).ok).toBe(true);
    const silent = normalizeTaskCard(draft({ permissionMode: "ask" }));
    if (silent.ok) expect(silent.card.readOnly).toBe(false);
    // A non-boolean is refused, not coerced.
    const malformed = normalizeTaskCard(draft({ readOnly: "yes" as never }));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toBe("read-only");
  });


  it("refuses an unknown permission mode and an unknown ask action", () => {
    expect(normalizeTaskCard(draft({ permissionMode: "root" as never })).ok).toBe(false);
    const unknown = normalizeTaskCard(draft({ mustAsk: ["publish" as never] }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBe("must-ask");
  });

  it("refuses out-of-bounds cards before the person is shown one", () => {
    const tooMany = Array.from({ length: MAX_MANDATE_CRITERIA + 1 }, (_, index) => ({
      text: `criterion ${index}`,
    }));
    expect(normalizeTaskCard(draft({ criteria: tooMany })).ok).toBe(false);
    expect(normalizeTaskCard(draft({ criteria: [] })).ok).toBe(false);
    expect(normalizeTaskCard(draft({ goal: "   " })).ok).toBe(false);
    expect(normalizeTaskCard(draft({ repo: { origin: "not a remote" } })).ok).toBe(false);
  });
});

describe("the always-asked actions cannot be switched off", () => {
  it("merges deploy, delete and spend into every card", () => {
    const result = normalizeTaskCard(draft({ mustAsk: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.mustAsk).toEqual(
      expect.arrayContaining(["deploy", "delete", "spend"]),
    );
  });

  it("keeps them in the frozen mandate even when the mandate omits them", () => {
    const frozen = freeze(draft({ mustAsk: [] }));
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.mandate.mustAsk).toEqual(
      expect.arrayContaining(["deploy", "delete", "spend"]),
    );
  });
});

describe("freezing produces the record the receiver validates", () => {
  it("keeps the proposed scope, deduplicates ids, and normalizes the repo", () => {
    const frozen = freeze(
      draft({
        criteria: [{ text: "one" }, { id: "b", text: "two" }],
        repo: { origin: "git@GitHub.com:Minih/Desktop.git", ref: "main" },
      }),
      { requestedBy: { hostId: "mac-mini", deviceId: "laptop" } },
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.mandate.criteria.map((c) => c.id)).toEqual(["c1", "b"]);
    expect(frozen.mandate.repo).toEqual({ origin: "github.com/Minih/Desktop", ref: "main" });
    expect(frozen.mandate.requestedBy).toEqual({
      kind: "user",
      hostId: "mac-mini",
      deviceId: "laptop",
    });
    // The frozen card must survive its own decoder, which is what a receiver
    // runs before trusting any field of it.
    expect(frozen.mandate.version).toBe(1);
    expect(frozen.mandate.sourceUtterance).toBe("登录超时今天修掉");
  });

  it("refuses a confirmation with no request behind it", () => {
    const result = freeze(draft(), { sourceUtterance: "  " });
    expect(result.ok).toBe(false);
  });

  it("refuses a duplicate criterion id rather than silently merging two", () => {
    const result = normalizeTaskCard(
      draft({
        criteria: [
          { id: "same", text: "one" },
          { id: "same", text: "two" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("criteria");
  });
});

describe("confirmation is once, and never an edit", () => {
  const drafted = (): DraftedCard => {
    const normalized = normalizeTaskCard(draft());
    if (!normalized.ok) throw new Error(normalized.message);
    return {
      draftId: "draft-1",
      status: "proposed",
      card: normalized.card,
      sourceUtterance: "登录超时今天修掉",
    };
  };

  it("freezes the draft the person was shown", () => {
    const result = confirmTaskCard(drafted(), {
      taskId: "task-1",
      sourceUtterance: "登录超时今天修掉",
      requestedBy: { hostId: "mac-mini" },
      createdAt: "2026-11-10T09:00:00.000Z",
      policyVersion: "steward-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafted.status).toBe("confirmed");
    expect(result.drafted.mandate?.goal).toBe("Fix the login timeout");
  });

  it("refuses a second confirmation instead of widening the authorization", () => {
    const first = confirmTaskCard(drafted(), {
      taskId: "task-1",
      sourceUtterance: "登录超时今天修掉",
      requestedBy: { hostId: "mac-mini" },
      createdAt: "2026-11-10T09:00:00.000Z",
      policyVersion: "steward-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = confirmTaskCard(first.drafted, {
      taskId: "task-2",
      sourceUtterance: "顺便把 remote-web 的 E2E 也看看",
      requestedBy: { hostId: "mac-mini" },
      createdAt: "2026-11-10T10:00:00.000Z",
      policyVersion: "steward-1",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("already-confirmed");
  });
});

describe("the effective permission is the narrower of card and ceilings", () => {
  it("never exceeds the card, and the card never exceeds the ceilings", () => {
    const frozen = freeze(draft({ permissionMode: "auto" }));
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const mandate: Mandate = frozen.mandate;
    expect(
      mandateCeiling({ mandate, sourceCeiling: "accept-edits", botCeiling: "auto" }),
    ).toBe("accept-edits");
    expect(mandateCeiling({ mandate, sourceCeiling: "auto", botCeiling: "ask" })).toBe("ask");
    // A narrow card stays narrow even when both ceilings are wider.
    const narrow = freeze(draft({ permissionMode: "ask" }));
    expect(narrow.ok).toBe(true);
    if (!narrow.ok) return;
    expect(
      mandateCeiling({ mandate: narrow.mandate, sourceCeiling: "auto", botCeiling: "auto" }),
    ).toBe("ask");
  });
});

describe("describeTaskCard", () => {
  it("shows the goal, criteria, the merged asks, and the repository", () => {
    const normalized = normalizeTaskCard(
      draft({ repo: { origin: "https://github.com/minih/minih-agent-desktop" } }),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const text = describeTaskCard(normalized.card);
    expect(text).toContain("goal: Fix the login timeout");
    expect(text).toContain("[c1] A failing repro exists");
    expect(text).toContain("deploy, delete, spend");
    expect(text).toContain("repo: github.com/minih/minih-agent-desktop");
  });
});
