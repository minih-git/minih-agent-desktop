import { describe, expect, it } from "vitest";

import { deriveStage, reportForStage, type StageInputs } from "./bot-stage.js";
import { TASK_STAGES, stageNeedsPerson, type TaskStage } from "./bot-session.js";

const inputs = (overrides: Partial<StageInputs> = {}): StageInputs => ({
  status: "running",
  ...overrides,
});

/**
 * The stage table of `03-runtime/10-session-state-machine.md` §6, one test per
 * row. Only the person-owned rows may disturb the person; that property is
 * asserted on every case rather than in one aggregate check, because it is the
 * rule a board of several employees depends on.
 */
describe("deriveStage — row 1, waiting for a person to answer", () => {
  it("wins over everything else and disturbs the person", () => {
    const stage = deriveStage(
      inputs({ waitingOnPerson: true, report: "blocked", status: "failed" }),
    );
    expect(stage).toBe("person/answer");
    expect(stageNeedsPerson(stage)).toBe(true);
  });
});

describe("deriveStage — row 2, waiting for a person to accept", () => {
  it("outranks blocked but not an open question", () => {
    const stage = deriveStage(inputs({ awaitingAcceptance: true, report: "blocked" }));
    expect(stage).toBe("person/accept");
    expect(stageNeedsPerson(stage)).toBe(true);
    expect(deriveStage(inputs({ awaitingAcceptance: true, waitingOnPerson: true }))).toBe(
      "person/answer",
    );
  });
});

describe("deriveStage — row 3, blocked or failed", () => {
  it("separates a worker's own blocker from a failed turn, and disturbs nobody", () => {
    // A worker that says it is blocked is reported as blocked, not as a failure.
    expect(deriveStage(inputs({ report: "blocked" }))).toBe("blocked");
    expect(deriveStage(inputs({ report: "failed" }))).toBe("failed");
    expect(deriveStage(inputs({ status: "failed" }))).toBe("failed");
    for (const stage of ["blocked", "failed"] as const) {
      expect(stageNeedsPerson(stage)).toBe(false);
    }
  });
});

describe("deriveStage — row 4, queued or waiting for the machine", () => {
  it("covers a queued delivery, an interrupted one, and a busy repository", () => {
    expect(deriveStage(inputs({ status: "queued" }))).toBe("queued");
    expect(deriveStage(inputs({ status: "interrupted" }))).toBe("queued");
    expect(deriveStage(inputs({ report: "waiting" }))).toBe("queued");
    expect(deriveStage(inputs({ repositoryBusy: true }))).toBe("queued");
    expect(stageNeedsPerson("queued")).toBe(false);
  });
});

describe("deriveStage — row 5, waiting for a configured trigger", () => {
  it("reports waiting without disturbing anyone", () => {
    const stage = deriveStage(inputs({ status: "completed", waitingForTrigger: true }));
    expect(stage).toBe("waiting");
    expect(stageNeedsPerson(stage)).toBe(false);
  });
});

describe("deriveStage — row 6, working", () => {
  it("is the running turn and an in-progress report", () => {
    expect(deriveStage(inputs({ status: "running" }))).toBe("working");
    expect(deriveStage(inputs({ report: "progress", status: "completed" }))).toBe("working");
    expect(stageNeedsPerson("working")).toBe(false);
  });
});

describe("the table is ordered, not a lookup", () => {
  it("keeps a person-owned stage above every mechanical one", () => {
    // The same delivery is both queued and blocked on an answer. The person
    // must see the answer row, because that is the only one they can act on.
    expect(
      deriveStage(
        inputs({ status: "queued", report: "blocked", repositoryBusy: true, waitingOnPerson: true }),
      ),
    ).toBe("person/answer");
  });

  it("every derived stage is a stage the vocabulary knows", () => {
    const cases: StageInputs[] = [
      inputs({ waitingOnPerson: true }),
      inputs({ awaitingAcceptance: true }),
      inputs({ report: "blocked" }),
      inputs({ report: "failed" }),
      inputs({ status: "failed" }),
      inputs({ status: "queued" }),
      inputs({ report: "waiting" }),
      inputs({ status: "completed", waitingForTrigger: true }),
      inputs({ status: "running" }),
      inputs({ report: "progress" }),
    ];
    for (const input of cases) {
      expect(TASK_STAGES).toContain(deriveStage(input));
    }
  });
});

describe("reportForStage", () => {
  it("maps every stage back to a report the ledger accepts", () => {
    for (const stage of TASK_STAGES) {
      const report = reportForStage(stage as TaskStage);
      expect(["progress", "waiting", "ready", "blocked", "failed", "dropped"]).toContain(report);
    }
  });

  it("uses ready for acceptance, which is what the six-value report reserves it for", () => {
    expect(reportForStage("person/accept")).toBe("ready");
    expect(reportForStage("progress" as TaskStage)).toBeUndefined();
  });
});
