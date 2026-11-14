import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskDeliveryCheck, TaskOverlap, TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import {
  canMergeNow,
  elapsedParts,
  gateReasonDetail,
  gateReasonKey,
  isAccepted,
  usageSummary,
} from "./task-delivery";
import { overlapRows, relayPosition } from "./task-relay";

/**
 * 「完成卡」: the employee delivered, and the person decides what happens next
 * (employee mode 0.5 slice 4b).
 *
 * The card is deliberately two-layered. What the **employee** says — a summary,
 * one line per acceptance criterion, what it left undone — is its own account of
 * the work. What the **host** can prove — the commits, the file count, the PR,
 * how long it took, what it cost, and whether CI is green — is a separate
 * section, because the person is deciding whether to trust the first layer and
 * the second layer is the evidence for it.
 *
 * The four buttons are the four decisions the design gives them: accept and
 * merge, accept only, send it back with one sentence, or add a requirement. The
 * merge button is the only one that can be greyed, and it always says why.
 */
export function TaskCompletionCard({
  task,
  employeeName,
  stewardSessionId,
  onChanged,
  variant = "session",
}: {
  task: TaskView;
  /** The employee's name; the heading names who delivered it. */
  employeeName?: string;
  /** Where 「追加要求」 goes; without it the button is not offered. */
  stewardSessionId?: string | null;
  /** Called after the host answered, so the caller can refetch its own rows. */
  onChanged?: () => void;
  /** `session` sits in the task's own composer; `dock` sits in the steward's. */
  variant?: "session" | "dock";
}) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const selectSession = useAppStore((state) => state.selectSession);
  const [check, setCheck] = useState<TaskDeliveryCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  /** What other tasks in this repository change, for the overlap line (slice 7). */
  const [overlap, setOverlap] = useState<TaskOverlap | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState<"reject" | "append" | null>(null);
  const [text, setText] = useState("");

  /**
   * One read when the card opens, and one per 刷新. No poll: `gh` answers a
   * question the person asked by clicking, and a timer would spend their tokens
   * on a question nobody asked.
   */
  const load = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await api.checkTaskDelivery(task.id));
    } catch (cause) {
      // A read that failed is a greyed button with the reason, never a green one
      // over an unknown state.
      setCheck(null);
      setCheckError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
    // The overlap is a hint beside the decision, so its own failure never
    // changes the verdict — it is reported as the gap it is and nothing more.
    if (task.projectPath) {
      try {
        setOverlap(
          await api.checkTaskOverlap({ projectPath: task.projectPath, taskId: task.id }),
        );
      } catch {
        setOverlap({ readable: false, tasks: [], intersections: [] });
      }
    }
  }, [task.id, task.projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const accept = () =>
    run("accept", async () => {
      await api.acceptTask(task.id);
    });

  const merge = () =>
    run("merge", async () => {
      const result = await api.mergeTaskDelivery(task.id);
      // A failure is the blocked card's news, not an exception: the task list is
      // refetched below and this card disappears with it.
      if (!result?.merged) {
        const detail = result?.detail ? ` (${result.detail})` : "";
        setError(t("bots.completion.mergeFailed", { step: result?.failedStep ?? "", detail }));
      }
    });

  /**
   * 「接受并交给下一棒」: accept this step and unlock the one behind it (slice 7).
   *
   * The next step's card was authorized when the person confirmed it, so this is
   * not a second decision: the host records the handoff and Main starts the step
   * that was waiting. A middle step never merges — its branch is the next step's
   * base.
   */
  const handoff = () =>
    run("handoff", async () => {
      const result = await api.handOffTask(task.id);
      // The handoff stands even when the next step could not start: the card
      // says what happened instead of pretending the click did nothing.
      if (result.startError) {
        setError(t("bots.completion.handoffFailed", { reason: result.startError }));
      }
    });

  const write = (kind: "reject" | "append") => {
    setWriting(kind);
    setText("");
  };

  const send = async () => {
    const words = text.trim();
    if (!words || !writing) return;
    if (writing === "reject") {
      await run("reject", async () => {
        const accepted = await sendPrompt(
          t("bots.completion.rejectMessage", { text: words }),
          undefined,
          task.sessionId,
        );
        if (!accepted) throw new Error(t("bots.completion.sendBusy"));
        setWriting(null);
        setText("");
      });
      return;
    }
    if (!stewardSessionId) {
      setError(t("bots.completion.noSteward"));
      return;
    }
    await run("append", async () => {
      // The steward decides whether this is still the same scope: inside it she
      // hands it to the same employee, outside it she proposes a new card.
      const accepted = await sendPrompt(
        t("bots.completion.appendMessage", {
          title: task.title,
          taskId: task.id,
          text: words,
        }),
        undefined,
        stewardSessionId,
      );
      if (!accepted) throw new Error(t("bots.completion.sendBusy"));
      setWriting(null);
      setText("");
    });
  };

  const openChanges = () => {
    void selectSession(task.sessionId);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-transcript-scroll]")?.focus();
    });
  };

  const accepted = isAccepted(task);
  const mergeable = task.deliveryMode !== "none";
  const ready = canMergeNow(check);
  const reasonKey = gateReasonKey(check?.reason);
  const reasonDetail = gateReasonDetail(check);
  const usage = usageSummary(check?.usage);
  const elapsed = elapsedParts(check?.elapsedMs);
  const commits = check?.changes?.commits ?? [];
  const result = task.result;
  const who = employeeName?.trim() || t("bots.card.targetUnknown");
  /** Where this step sits in its chain, and the steps the merge would carry. */
  const position = relayPosition(task);
  const middle = !position.isLast;
  const chainSteps = check?.changes?.steps ?? [];
  const overlapLines = overlapRows(overlap, t);

  return (
    <section
      className={`task-completion-card${accepted ? " accepted" : ""}`}
      role="region"
      aria-label={t("bots.completion.title", { name: who })}
      data-task-completion={task.id}
      data-completion-accepted={accepted ? "true" : "false"}
      data-completion-can-merge={ready ? "true" : "false"}
      data-completion-reason={check?.reason ?? ""}
      data-completion-variant={variant}
      data-completion-relay-step={position.total > 1 ? `${position.step}/${position.total}` : undefined}
      data-completion-relay-middle={middle ? "true" : undefined}
      aria-busy={busy ? true : undefined}
    >
      <div className="task-completion-header">
        <span className="task-completion-title">
          {accepted
            ? t("bots.completion.acceptedTitle", { name: who })
            : t("bots.completion.title", { name: who })}
        </span>
        <span className="task-completion-task">#{task.shortId}</span>
        <Button
          variant="ghost"
          disabled={checking || Boolean(busy)}
          onClick={() => void load()}
          data-completion-refresh=""
        >
          {t("bots.completion.refresh")}
        </Button>
      </div>
      <p className="task-completion-goal">{task.title}</p>

      {position.total > 1 ? (
        // Where this step sits, and what the button on the right does about it:
        // a step in between hands its branch on, the last one merges the chain.
        <p className="task-completion-relay" data-completion-relay="">
          <span>{t("bots.completion.chainStep", { step: position.step, total: position.total })}</span>
          <span className="task-completion-count">
            {middle ? t("bots.completion.handoffHint") : t("bots.completion.chainLast")}
          </span>
        </p>
      ) : null}

      {accepted ? (
        <p className="task-completion-note" data-completion-accepted-note="">
          {/* Accepted is not the same as done with it: a middle step still owes
              the next one its branch. */}
          {middle
            ? t("bots.completion.handoffWaiting")
            : t("bots.completion.acceptedNote")}
        </p>
      ) : null}

      {result?.summary ? (
        <p className="task-completion-summary">{result.summary}</p>
      ) : (
        <p className="task-completion-summary muted">{t("bots.completion.noReport")}</p>
      )}

      {result?.acceptance?.length ? (
        <ul className="task-completion-criteria" data-completion-criteria="">
          {result.acceptance.map((entry, index) => (
            <li
              key={`${entry.criterion}:${index}`}
              className={entry.met ? "met" : "unmet"}
              data-completion-criterion={entry.met ? "met" : "unmet"}
            >
              <span className="task-completion-mark" aria-hidden="true">
                {entry.met ? "✓" : "✗"}
              </span>
              <span className="task-completion-criterion">{entry.criterion}</span>
              {entry.note ? <span className="task-completion-note-inline">{entry.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {result?.leftovers?.length ? (
        <div className="task-completion-leftovers" data-completion-leftovers="">
          <span className="task-completion-label">{t("bots.completion.leftovers")}</span>
          <ul>
            {result.leftovers.map((line, index) => (
              <li key={`${line}:${index}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {commits.length > 0 || check?.prUrl ? (
        <div className="task-completion-changes" data-completion-changes="">
          <span className="task-completion-label">{t("bots.completion.changes")}</span>
          {check?.changes ? (
            <span className="task-completion-count">
              {t("bots.completion.changeCount", {
                commits: check.changes.commits.length,
                files: check.changes.files,
              })}
            </span>
          ) : null}
          {commits.length ? (
            <ul className="task-completion-commits">
              {commits.map((commit) => (
                <li key={commit.sha}>
                  <code>{commit.sha}</code>
                  <span>{commit.subject}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {check?.changes?.truncated ? (
            <span className="task-completion-count">
              {t("bots.completion.moreCommits", { count: check.changes.commits.length })}
            </span>
          ) : null}
          {chainSteps.length ? (
            // A chain is merged whole, so the card lists it whole: which stub
            // came from which step is the one thing the merge itself cannot show
            // afterwards (slice 7).
            <ul className="task-completion-chain" data-completion-chain="">
              {chainSteps.map((entry, index) => (
                <li key={entry.taskId} data-chain-step={entry.shortId}>
                  <span className="task-completion-count">
                    {t("bots.completion.chainStep", {
                      step: index + 1,
                      total: chainSteps.length,
                    })}{" "}
                    · #{entry.shortId}
                  </span>
                  <span className="task-completion-count">
                    {t("bots.completion.chainStepCount", {
                      commits: entry.commits.length,
                      files: entry.files,
                    })}
                  </span>
                  <ul className="task-completion-commits">
                    {entry.commits.map((commit) => (
                      <li key={`${entry.shortId}:${commit.sha}`}>
                        <code>{commit.sha}</code>
                        <span>{commit.subject}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
          {check?.prUrl ? (
            <a
              className="task-completion-link"
              href={check.prUrl}
              target="_blank"
              rel="noreferrer"
              data-completion-pr=""
            >
              {t("bots.completion.openPr")}
            </a>
          ) : null}
          <Button variant="ghost" onClick={openChanges} data-completion-diff="">
            {t("bots.completion.viewChanges")}
          </Button>
        </div>
      ) : null}

      {overlapLines.length ? (
        // The one thing the host can prove about a collision: two tasks in this
        // repository change the same file. A warning, not a verdict (slice 7).
        <div className="task-completion-overlap" data-completion-overlap="">
          <span className="task-completion-label">{t("bots.completion.changes")}</span>
          <ul>
            {overlapLines.map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="task-completion-foot" data-completion-foot="">
        <span>
          {t("bots.completion.elapsed", {
            hours: elapsed.hours,
            minutes: elapsed.minutes,
          })}
        </span>
        {usage ? (
          <span>
            {usage.costUsd === undefined
              ? t("bots.completion.tokens", { tokens: usage.tokens })
              : t("bots.completion.tokensAndCost", {
                  tokens: usage.tokens,
                  cost: usage.costUsd.toFixed(2),
                })}
          </span>
        ) : null}
        {check?.checks ? (
          <span>
            {t("bots.completion.checks", {
              passed: check.checks.passed,
              total: check.checks.total,
            })}
          </span>
        ) : null}
      </p>

      {mergeable && !ready ? (
        <p className="task-completion-reason" role="status" data-completion-blocked-by="">
          {checkError
            ? t("bots.completion.reason.prUnreadable", { reason: checkError })
            : checking && !check
              ? t("bots.completion.reason.checking")
              : t(reasonKey, { reason: reasonDetail || "" })}
        </p>
      ) : null}

      {writing ? (
        <div className="task-completion-writer">
          <textarea
            className="task-completion-input"
            value={text}
            autoFocus
            placeholder={
              writing === "reject"
                ? t("bots.completion.rejectPlaceholder")
                : t("bots.completion.appendPlaceholder")
            }
            onChange={(event) => setText(event.target.value)}
            data-completion-input={writing}
          />
          <div className="task-completion-writer-actions">
            <Button
              variant="primary"
              disabled={!text.trim() || Boolean(busy)}
              onClick={() => void send()}
              data-completion-send={writing}
            >
              {t("bots.completion.send")}
            </Button>
            <Button variant="ghost" onClick={() => setWriting(null)}>
              {t("bots.completion.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="task-completion-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="task-completion-actions">
        {middle ? (
          // A step in between hands its branch on: the next step continues from
          // it, and only the last step is merged (slice 7). The chain's gate —
          // PR, CI, review — is the last step's question, not this one's.
          <Button
            variant="primary"
            disabled={Boolean(busy)}
            onClick={() => void handoff()}
            data-completion-handoff=""
            title={t("bots.completion.handoffHint")}
          >
            {t("bots.completion.handoff")}
          </Button>
        ) : mergeable ? (
          <Button
            variant="primary"
            disabled={!ready || Boolean(busy)}
            onClick={() => void merge()}
            data-completion-merge=""
            title={ready ? t("bots.completion.mergeHint") : t(reasonKey, { reason: reasonDetail })}
          >
            {t("bots.completion.merge")}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          disabled={accepted || Boolean(busy)}
          onClick={() => void accept()}
          data-completion-accept=""
        >
          {t("bots.completion.accept")}
        </Button>
        <Button
          variant="secondary"
          disabled={Boolean(busy)}
          onClick={() => write("reject")}
          data-completion-reject=""
        >
          {t("bots.completion.reject")}
        </Button>
        {stewardSessionId ? (
          <Button
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => write("append")}
            data-completion-append=""
          >
            {t("bots.completion.append")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
