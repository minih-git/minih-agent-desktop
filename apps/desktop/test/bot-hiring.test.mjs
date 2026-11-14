import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * Hiring, one-sentence drafts and team norms (employee mode 0.5 slice 6), as
 * pure data and pure functions: no renderer, no Electron, no model.
 *
 * What is being pinned:
 *   - a template is the six jobs of the plan, with the ceiling and the model
 *     preference the person is shown;
 *   - a draft never widens what its template allows, and its project only ever
 *     points at one that already exists;
 *   - the norms text says what it is, and a task turn carries it after the task
 *     rules without the two accumulating;
 *   - a task session's persona is its employee's role.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const shared = await import("../../../packages/shared/src/bot-hiring.ts");
const normsLib = await import("../../../packages/shared/src/team-norms.ts");
const hireDraft = await import("../electron/main/services/hire-draft.ts");
const persona = await import("../electron/main/runtime/bot-persona.ts");
const teamNorms = await import("../electron/main/services/team-norms.ts");
const taskStatus = await import("../electron/main/services/task-status.ts");

const definition = (name, tools = ["Read"]) => ({
  name,
  description: `${name} definition`,
  tools,
  source: "builtin",
  prompt: `You are ${name}.`,
});

test("the six jobs of the plan, with the ceiling each one starts at", () => {
  const byId = Object.fromEntries(shared.HIRE_TEMPLATES.map((item) => [item.id, item]));
  assert.deepEqual(Object.keys(byId).sort(), [
    "backend",
    "design",
    "frontend-logic",
    "research",
    "review",
    "ui",
  ]);
  // 界面: an interface coder if the person installed one, otherwise the shipped
  // designer; it is the only template that asks for a Gemini-family model.
  assert.deepEqual(byId.ui.definitions, ["ui-coder", "ui-designer"]);
  assert.equal(byId.ui.permissionMode, "accept-edits");
  assert.equal(byId.ui.modelPreference, "ui");
  assert.equal(byId.ui.bindsRepository, true);
  assert.equal(byId.ui.readOnly, false);
  // 前端逻辑: a non-Gemini coding model, and it is still repo-bound.
  assert.equal(byId["frontend-logic"].definitions[0], "fixer");
  assert.equal(byId["frontend-logic"].modelPreference, "coding");
  // 审查 and 研究员 are the read-only jobs, and only 研究员 is unbound.
  assert.equal(byId.review.permissionMode, "ask");
  assert.equal(byId.review.readOnly, true);
  assert.equal(byId.review.bindsRepository, true);
  assert.equal(byId.research.permissionMode, "ask");
  assert.equal(byId.research.readOnly, true);
  assert.equal(byId.research.bindsRepository, false);
  for (const template of shared.HIRE_TEMPLATES) {
    // Every template is confirmable: a name, a duty and an installed candidate.
    assert.equal(typeof template.nameKey, "string");
    assert.equal(typeof template.dutyKey, "string");
    assert.ok(template.definitions.length > 0);
  }
});

test("a template resolves to the first definition the person actually has", () => {
  const ui = shared.hireTemplate("ui");
  assert.equal(
    shared.resolveHireTemplateDefinition(ui, ["ui-coder", "ui-designer", "fixer"]),
    "ui-coder",
  );
  assert.equal(shared.resolveHireTemplateDefinition(ui, ["ui-designer"]), "ui-designer");
  // Neither installed: the form must ask, not guess an empty role.
  assert.equal(shared.resolveHireTemplateDefinition(ui, ["fixer"]), undefined);
});

test("the suggested model follows the template's preference, or stays empty", () => {
  const choices = shared.hireModelChoices([
    { id: "anthropic", name: "Anthropic", enabled: true, hasSecret: true, models: [{ id: "claude-x" }] },
    { id: "google", name: "Google", enabled: true, hasSecret: true, models: [{ id: "gemini-3-pro" }] },
    { id: "dead", name: "Dead", enabled: true, hasSecret: false, authKind: "api_key", models: [{ id: "x" }] },
  ]);
  assert.equal(choices.length, 2, "a provider without a credential is not offered");
  assert.equal(shared.pickHireModel(shared.hireTemplate("ui"), choices), "google/gemini-3-pro");
  assert.equal(
    shared.pickHireModel(shared.hireTemplate("frontend-logic"), choices),
    "anthropic/claude-x",
  );
  assert.equal(shared.pickHireModel(shared.hireTemplate("backend"), choices), "");
  // 界面 with no Gemini-family model: nothing to suggest, and no guess.
  const withoutGemini = choices.filter((choice) => !choice.interfaceModel);
  assert.equal(shared.pickHireModel(shared.hireTemplate("ui"), withoutGemini), "");
});

test("a model draft is narrowed to its template, never widened", () => {
  const projects = [{ path: "/repo/Minih-Router", name: "Minih-Router" }];
  const answer = (payload) => hireDraft.draftFromAnswer(JSON.stringify(payload), { projects });

  // A fenced answer is still JSON; the template's mustAsk is the one that wins.
  const fenced = hireDraft.draftFromAnswer(
    "```json\n" +
      JSON.stringify({
        templateId: "review",
        name: "Reviewer",
        duty: "Reviews the gateway",
        permissionMode: "auto",
        projectHint: "Router",
        reason: "the work is a review",
      }) +
      "\n```",
    { projects },
  );
  assert.equal(fenced.ok, true, JSON.stringify(fenced));
  // `auto` is wider than the review template's `ask`, so it lands at `ask`.
  assert.equal(fenced.draft.permissionMode, "ask");
  assert.deepEqual(fenced.draft.mustAsk, ["deploy", "delete", "spend"]);
  assert.equal(fenced.draft.projectPath, "/repo/Minih-Router");
  assert.equal(fenced.draft.templateId, "review");

  // A narrower mode is the model's call.
  const narrowed = answer({ templateId: "backend", name: "Backend", permissionMode: "ask" });
  assert.equal(narrowed.draft.permissionMode, "ask");

  // An unknown template is refused, so the form never opens on nothing.
  const unknown = answer({ templateId: "cto", name: "CTO" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "HIRE_DRAFT_UNKNOWN_TEMPLATE");

  // Prose, an array, or a broken object is refused rather than coerced.
  assert.equal(hireDraft.draftFromAnswer("I would hire a reviewer.").code, "HIRE_DRAFT_INVALID");
  assert.equal(hireDraft.draftFromAnswer("[]").code, "HIRE_DRAFT_INVALID");
  // A name is required: a draft the person cannot see is not a draft.
  assert.equal(answer({ templateId: "ui", name: "   " }).code, "HIRE_DRAFT_INVALID");

  // Over-long text is truncated to the profile's own limits, not rejected.
  const long = answer({ templateId: "ui", name: "N".repeat(200), duty: "d".repeat(900) });
  assert.equal(long.draft.name.length, 80);
  assert.equal(long.draft.duty.length, 500);

  // A project hint only ever matches a project that already exists.
  assert.equal(
    answer({ templateId: "backend", name: "Backend", projectHint: "Somewhere else" }).draft
      .projectPath,
    undefined,
  );
});

test("one sentence becomes a draft through the Super Agent's model", async () => {
  const calls = [];
  const drafter = hireDraft.createHireDrafter({
    getHost: () => ({
      call: async (method) => {
        if (method === "bot.list") {
          return {
            bots: [
              {
                sessionId: "steward",
                modelKey: "google/gemini-3-pro",
                profile: { name: "Super Agent", definition: "steward" },
              },
            ],
          };
        }
        if (method === "projects.list") {
          return { projects: [{ path: "/repo/Minih-Router", name: "Minih-Router" }] };
        }
        throw new Error(`unexpected call ${method}`);
      },
    }),
    getSettings: async () => ({ models: {} }),
    resolveRuntimeModel: async () => ({ provider: { id: "google", modelId: "gemini-3-pro" } }),
    vendorOAuth: { resolveAuth: async () => null },
    logger: { app: () => {} },
    // No real model: the answer is this string.
    completeOneShot: async (provider, context) => {
      calls.push({ provider, user: context.messages[0].content });
      return {
        text: JSON.stringify({
          templateId: "backend",
          name: "Router 计费",
          duty: "Minih-Router 的计费与额度。",
          permissionMode: "accept-edits",
          projectHint: "Minih-Router",
          reason: "说的是网关的计费代码。",
        }),
      };
    },
  });

  const outcome = await drafter.draft("招一个管 Router 计费的后端");
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(
    {
      templateId: outcome.draft.templateId,
      name: outcome.draft.name,
      permissionMode: outcome.draft.permissionMode,
      projectPath: outcome.draft.projectPath,
    },
    {
      templateId: "backend",
      name: "Router 计费",
      permissionMode: "accept-edits",
      projectPath: "/repo/Minih-Router",
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider.id, "google");
  // The person's sentence rides in the user turn; the template list is a system
  // prompt, so the model never sees the ids as something the person said.
  assert.match(calls[0].user, /Router 计费的后端/);
});

test("without a Super Agent model the draft says what to do instead", async () => {
  const drafter = hireDraft.createHireDrafter({
    getHost: () => ({ call: async () => ({ bots: [] }) }),
    getSettings: async () => ({}),
    resolveRuntimeModel: async () => {
      throw new Error("must not resolve a model");
    },
    vendorOAuth: { resolveAuth: async () => null },
    logger: { app: () => {} },
    completeOneShot: async () => {
      throw new Error("must not call a model");
    },
  });
  const outcome = await drafter.draft("招一个后端");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "HIRE_DRAFT_NO_MODEL");
  assert.match(outcome.message, /Super Agent/);

  // An empty sentence never reaches a model either.
  const empty = await drafter.draft("   ");
  assert.equal(empty.code, "HIRE_DRAFT_EMPTY_SENTENCE");
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

test("the norms block says what it is, and a task turn carries it after the rules", async () => {
  const written = {
    version: 1,
    communication: "用中文汇报，先给结论",
    scope: "不要重排没改过的文件",
    delivery: "",
  };
  const block = teamNorms.teamNormsBriefing(written);
  assert.match(block, /^\[Team norms/);
  assert.match(block, /\[\/Team norms\]$/);
  assert.match(block, /Communication: 用中文汇报，先给结论/);
  assert.match(block, /Scope: 不要重排没改过的文件/);
  assert.doesNotMatch(block, /Delivery:/, "an empty section is not printed");
  // The boundary sentence is the whole reason this text is safe to inject.
  assert.match(block, /never authorize an action the host would refuse/);

  const call = async (method) => {
    if (method === "team.norms.get") return { norms: written };
    throw new Error(`unexpected call ${method}`);
  };
  const briefing = await taskStatus.buildTaskSessionBriefing(call);
  assert.ok(briefing.startsWith(taskStatus.TASK_SESSION_BRIEFING));
  assert.ok(briefing.includes(block), "the norms follow the task rules");
  // Per turn, from the stored record: two turns are byte-identical, so nothing
  // accumulates and nothing goes stale.
  assert.equal(await taskStatus.buildTaskSessionBriefing(call), briefing);

  // No norms written: the turn is exactly slice 4a's rules, with no empty block.
  const without = await taskStatus.buildTaskSessionBriefing(async () => ({ norms: null }));
  assert.equal(without, taskStatus.TASK_SESSION_BRIEFING);

  // A read that failed is reported as such, never as "the team has no rules".
  const unreadable = await taskStatus.buildTaskSessionBriefing(async () => {
    throw new Error("host unavailable");
  });
  assert.ok(unreadable.startsWith(taskStatus.TASK_SESSION_BRIEFING));
  assert.match(unreadable, /could not be read/);
});

test("the steward's brief carries one truncated line of the norms", async () => {
  const long = {
    version: 1,
    communication: "字".repeat(700),
    scope: "",
    delivery: "",
  };
  const line = teamNorms.stewardNormsLine(long);
  assert.match(line, /^The team norms every employee follows: /);
  assert.ok(line.endsWith("…"), "a cut line says it was cut");
  assert.ok(
    line.length <= "The team norms every employee follows: ".length + 600,
    `line is ${line.length} characters`,
  );

  const board = { tasks: [], employees: [] };
  const call = async (method) => {
    if (method === "task.list") return { tasks: [] };
    if (method === "bot.list") return { bots: [] };
    if (method === "team.norms.get") return { norms: { version: 1, communication: "先说结论" } };
    throw new Error(`unexpected call ${method}`);
  };
  const briefing = await taskStatus.buildStewardBriefing(call, "Super Agent");
  assert.match(briefing, /The team norms every employee follows: 先说结论/);

  // A board with no tasks still produces a brief, and it is still the same one.
  assert.equal(taskStatus.stewardBriefing(board, "Super Agent"), taskStatus.stewardBriefing(board, "Super Agent"));
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
      { name: "Super Agent", permissionMode: "ask", mustAsk: [], observe: false, definition: "steward" },
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

test("the roster word tells the steward who reviews and who researches", () => {
  assert.equal(shared.roleWordForDefinition("code-reviewer"), "reviewer");
  assert.equal(shared.roleWordForDefinition("explorer"), "researcher");
  assert.equal(shared.roleWordForDefinition("fixer"), "coder");
  // An unknown handle is its own word rather than an invented one.
  assert.equal(shared.roleWordForDefinition("my-custom-role"), "my-custom-role");
  assert.equal(shared.roleWordForDefinition(undefined), "");
  assert.equal(shared.isReadOnlyDefinition("code-reviewer"), true);
  assert.equal(shared.isReadOnlyDefinition("explorer"), true);
  assert.equal(shared.isReadOnlyDefinition("fixer"), false);
});