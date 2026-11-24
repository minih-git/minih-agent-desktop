import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * What a task turn is told, as pure data and pure functions: no renderer, no
 * Electron, no model.
 *
 * What is being pinned:
 *   - the team norms are still stored and validated, but a task turn carries
 *     none of them: the settings page that wrote them is gone, and the text it
 *     injected no longer belongs to a turn;
 *   - a task session's persona is its employee's role.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const normsLib = await import("../../../packages/shared/src/team-norms.ts");
const persona = await import("../electron/main/runtime/bot-persona.ts");
const taskStatus = await import("../electron/main/services/task-status.ts");

const definition = (name, tools = ["Read"]) => ({
  name,
  description: `${name} definition`,
  tools,
  source: "builtin",
  prompt: `You are ${name}.`,
});

test("team norms are bounded, and check them before they are stored", () => {
  const ok = normsLib.checkTeamNorms({ communication: " 先说结论 ", scope: "", delivery: "" });
  assert.equal(ok.ok, true);
  assert.equal(ok.norms.communication, "先说结论");
  assert.equal(ok.norms.version, normsLib.TEAM_NORMS_VERSION);

  const tooLong = normsLib.checkTeamNorms({
    communication: "字".repeat(normsLib.MAX_TEAM_NORM_SECTION_CHARS + 1),
  });
  assert.deepEqual(tooLong, { ok: false, reason: "section" });

  const tooBig = normsLib.checkTeamNorms({
    communication: "字".repeat(normsLib.MAX_TEAM_NORM_SECTION_CHARS),
    scope: "字".repeat(normsLib.MAX_TEAM_NORM_SECTION_CHARS),
    delivery: "字".repeat(normsLib.MAX_TEAM_NORM_SECTION_CHARS),
  });
  assert.deepEqual(tooBig, { ok: false, reason: "total" });

  // Nothing written is the state a fresh install is in.
  assert.equal(normsLib.teamNormsAreEmpty(normsLib.emptyTeamNorms()), true);
});

test("a task turn carries the task rules and nothing about team norms", async () => {
  const asked = [];
  const call = async (method) => {
    asked.push(method);
    // Stored norms exist on this computer and are still readable through the
    // host RPC; the turn must simply not ask for them any more.
    if (method === "team.norms.get") return { norms: { version: 1, communication: "用中文汇报" } };
    if (method === "task.list") return { tasks: [] };
    throw new Error(`unexpected call ${method}`);
  };

  const briefing = await taskStatus.buildTaskSessionBriefing(call);
  assert.equal(briefing, taskStatus.TASK_SESSION_BRIEFING);
  assert.doesNotMatch(briefing, /team norms/i);
  assert.deepEqual(asked, [], "the briefing asked the host for something");
});

test("a task session runs as its employee's role", () => {
  const definitions = [definition("code-reviewer"), definition("explorer"), definition("fixer")];

  const reviewer = persona.resolveTaskPersona(
    { name: "审查员", permissionMode: "ask", mustAsk: [], observe: false, definition: "code-reviewer" },
    definitions,
  );
  assert.equal(reviewer.kind, "resolved");
  assert.equal(reviewer.scope, "task");
  // The task keeps the task rules' tools on top of the role, and nothing wider.
  assert.deepEqual(persona.runtimeBotPersona(reviewer), {
    definition: definitions[0],
    taskSession: true,
  });

  // A typo is a refusal, not "no persona": that would run the task with every
  // tool the session has.
  const missing = persona.resolveTaskPersona(
    { name: "审查员", permissionMode: "ask", mustAsk: [], observe: false, definition: "code-reveiwer" },
    definitions,
  );
  assert.deepEqual(missing, { kind: "missing", name: "code-reveiwer" });
  assert.deepEqual(persona.runtimeBotPersona(missing), { missingName: "code-reveiwer" });

  // The steward does not hand work to herself, so her definition is not a role a
  // task runs as.
  assert.deepEqual(
    persona.resolveTaskPersona(
      { name: "Super Agent", permissionMode: "ask", mustAsk: [], observe: false },
      definitions,
    ),
    { kind: "none" },
  );
  // An employee without a definition keeps today's behaviour.
  assert.deepEqual(
    persona.resolveTaskPersona(
      { name: "小工", permissionMode: "ask", mustAsk: [], observe: false },
      definitions,
    ),
    { kind: "none" },
  );

  // The employee's own container is a different scope: no task tools for it.
  const container = persona.resolveBotPersona(
    "bot",
    { name: "审查员", permissionMode: "ask", mustAsk: [], observe: false, definition: "code-reviewer" },
    definitions,
  );
  assert.equal(container.scope, "employee");
  assert.deepEqual(persona.runtimeBotPersona(container), { definition: definitions[0] });
});