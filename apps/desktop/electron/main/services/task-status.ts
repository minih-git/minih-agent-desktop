import { type TaskView } from "@minih-agent/shared";
import { readTeamNorms, teamNormsBriefing } from "./team-norms";

export type BoardReader = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

/**
 * The rules a **task session** runs under, injected each turn and never written
 * to the transcript (employee mode 0.5 slice 4a).
 *
 * A task session has no employee definition, so nothing else tells it how to ask
 * for a decision or how to give up: without this block a stuck employee ends its
 * turn with a paragraph of prose, the person cannot tell that work stopped, and
 * the task looks finished. Three rules, and the third is the one the card exists
 * for.
 *
 * It is English because it is a prompt, and it rides with the turn for the same
 * reason the steward's brief does: it is data for this request only, so it can
 * never accumulate, go stale, or be read as something the person said.
 */
export const TASK_SESSION_BRIEFING = [
  "[Host rules for this task · not a message from the person]",
  "You are running one task for an employee. These rules come from the host, not from the conversation.",
  "- If the work needs a person's decision, ask exactly one specific question with AskTool and offer 2–4 concrete options, putting the one you recommend first.",
  "- Never end a turn with a question in prose. A sentence nobody can answer is not a question, and the person will not see it as one.",
  '- If you are stuck — missing access, a step you cannot get past, an ambiguity only the person can resolve — call TaskReport with { status: "blocked", where, tried, suggestion } and then end the turn.',
  "- If you need permission to act, call the tool and let the host ask the person. Do not ask for permission in prose first.",
  "- When the work is done, call TaskReport with { status: \"ready\", summary, acceptance: [{ criterion, met, note? }], leftovers } — one entry per acceptance criterion, each marked met or not — and end the turn; do not describe it only in prose.",
  "- A pull-request task pushes its branch and opens the PR before it reports ready.",
  "- When the work is done, say what changed and end the turn; do not ask whether to continue.",
  "[/Host rules for this task]",
].join("\n");


/**
 * The rules a **task** turn runs under: slice 4a's rules, then the team norms
 * the person wrote (slice 6).
 *
 * Same channel as the rules — attached to this request only, never written to
 * the transcript — so a norm cannot accumulate over turns or be read back as
 * something the person said in the conversation. A norms read that fails says
 * so: "no team rules" and "could not read them" are different facts, and the
 * second one must not be presented as the first.
 */
export async function buildTaskSessionBriefing(
  call: BoardReader,
  sessionId?: string,
): Promise<string> {
  const norms = await readTeamNorms(call);
  const relay = relayStepBriefing(call, sessionId);
  if (norms.kind === "norms") {
    return [TASK_SESSION_BRIEFING, "", await relay, teamNormsBriefing(norms.norms)]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (norms.kind === "unreadable") {
    return [
      TASK_SESSION_BRIEFING,
      "",
      await relay,
      "[Team norms could not be read for this turn, so none are attached. Do not",
      `assume the team has no rules; say so if it matters. (${norms.reason})]`,
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  const line = await relay;
  return line ? [TASK_SESSION_BRIEFING, "", line].join("\n") : TASK_SESSION_BRIEFING;
}

/**
 * Where this task sits in its relay chain, as the task session has to know it
 * (employee mode 0.5 slice 7).
 *
 * The host knows the position because it owns the chain, so it is injected here
 * rather than left to the employee to infer from a branch name. Two rules matter
 * and both are stated plainly:
 *
 * - a step that is not the last one **commits and stops**: pushing now would open
 *   a pull request for half a change, and the next step's branch is built on
 *   this one's commits;
 * - the last step **pushes and opens one pull request for the whole chain**,
 *   because that merge is what carries every earlier step to `main`.
 *
 * A task in no chain gets nothing: a rule about a chain nobody is in is noise.
 */
async function relayStepBriefing(call: BoardReader, sessionId?: string): Promise<string> {
  if (!sessionId) return "";
  let task: TaskView | undefined;
  try {
    const listed = await call<{ tasks?: TaskView[] }>("task.list", {
      sessionId,
      includeArchived: false,
    });
    task = listed?.tasks?.[0];
  } catch {
    // A board that cannot be read is reported as the gap it is, never as
    // "you are the last step" — that would make a middle step push.
    return [
      "[Host rules for this task · not a message from the person]",
      "This task's place in a relay chain could not be read, so no step rule is",
      "attached. Do not push or open a pull request until you know whether you are",
      "the last step.",
      "[/Host rules for this task]",
    ].join("\n");
  }
  const total = task?.relayTotal ?? 1;
  const step = task?.relayStep ?? 1;
  if (total <= 1) return "";
  const rule =
    step < total
      ? `You are step ${step} of ${total}: commit your work; do not push or open a PR — the next step continues from your branch.`
      : "You are the last step: push the branch and open one PR for the whole chain.";
  return [
    "[Host rules for this task · not a message from the person]",
    rule,
    "[/Host rules for this task]",
  ].join("\n");
}