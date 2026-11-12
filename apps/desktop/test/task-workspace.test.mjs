import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * How a task's workspace is described, and the dependency template (employee
 * mode 0.5 slice 2; ADR 0329 amendment 2026-11).
 *
 * Both are pure: the header and the workbench row read the same words from the
 * first module, and the second is the shell snippet a person fills in and then
 * edits. The real clicks are covered by bot-task-workspace-user-path.test.mjs.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { asksBeforeDiscarding, baseRefLabel, deliveryModeKey, taskBranch, workspaceStatusKey } =
  await import("../src/features/bots/task-workspace.ts");
const { MAIN_WORKSPACE_DEPENDENCY_TEMPLATE, setupTemplateAvailable } = await import(
  "../src/features/worktree/worktree-setup-template.ts"
);

test("a workspace state has words, and no repository is not a state to show", () => {
  assert.equal(workspaceStatusKey("preparing"), "bots.tasks.workspacePreparing");
  assert.equal(workspaceStatusKey("ready"), "bots.tasks.workspaceReady");
  assert.equal(workspaceStatusKey("failed"), "bots.tasks.workspaceFailed");
  // A task without a repository works in its session's folder: nothing to say.
  assert.equal(workspaceStatusKey("none"), null);
});

test("the delivery route is named by what actually happens", () => {
  assert.equal(deliveryModeKey("pr"), "bots.tasks.deliveryPr");
  assert.equal(deliveryModeKey("local"), "bots.tasks.deliveryLocal");
  assert.equal(deliveryModeKey("none"), null);
  assert.equal(deliveryModeKey(undefined), null);
});

test("the start point reads as the commit it really was", () => {
  // A fetched remote branch keeps its remote, so the header can say where the
  // work started without repeating `refs/remotes/`.
  assert.deepEqual(baseRefLabel("refs/remotes/origin/main", true), {
    label: "origin/main",
    remote: true,
  });
  // A local fallback says so: the person has to be able to tell that the task
  // started from a copy that may be behind the remote.
  assert.deepEqual(baseRefLabel("refs/heads/main", false), { label: "main", remote: false });
  // The flag wins when the host sends one, and the ref decides when it does not.
  assert.equal(baseRefLabel("refs/remotes/origin/main", undefined)?.remote, true);
  assert.equal(baseRefLabel("refs/heads/main", true)?.remote, true);
  assert.equal(baseRefLabel(undefined, true), null);
  assert.equal(baseRefLabel("   ", false), null);
});

test("the branch shown is the one the host created, falling back to the ask", () => {
  assert.equal(taskBranch({ workspaceBranch: "minih-agent/abc", branch: "fix/login" }), "minih-agent/abc");
  assert.equal(taskBranch({ branch: "fix/login" }), "fix/login");
  assert.equal(taskBranch({ workspaceBranch: "  " }), null);
  assert.equal(taskBranch({}), null);
});

test("the dependency template links every node_modules and skips what exists", () => {
  const snippet = MAIN_WORKSPACE_DEPENDENCY_TEMPLATE;
  // It reads the two variables the host provides and nothing machine-specific.
  assert.match(snippet, /\$PI_PROJECT_ROOT/);
  assert.match(snippet, /\$PI_WORKTREE_ROOT/);
  // The relative path is preserved, so a monorepo's nested trees line up.
  assert.match(snippet, /relative="\$\{dir#"\$PI_PROJECT_ROOT"\/\}"/);
  // Nested dependency trees and other tasks' folders are not walked into.
  assert.match(snippet, /-name \.git -o -name \.worktree/);
  assert.match(snippet, /-type d -name node_modules -prune -print/);
  // An existing path is left alone rather than replaced.
  assert.match(snippet, /\[ -e "\$target" \] && continue/);
  assert.match(snippet, /ln -s "\$dir" "\$target"/);
});

test("the template is offered only where it can run as written", () => {
  assert.equal(setupTemplateAvailable("darwin"), true);
  assert.equal(setupTemplateAvailable("linux"), true);
  assert.equal(setupTemplateAvailable("win32"), false);
});
test("both archive refusals ask before discarding", () => {
  // "It still holds work" and "it could not be checked" are the two answers that
  // need a second click; neither may be read as "nothing to lose".
  assert.equal(asksBeforeDiscarding("WORKSPACE_HAS_UNSAVED_WORK"), true);
  assert.equal(asksBeforeDiscarding("WORKSPACE_UNSAVED_UNKNOWN"), true);
  // Everything else is a real failure to show, not a question to ask.
  assert.equal(asksBeforeDiscarding("WORKTREE_BUSY"), false);
  assert.equal(asksBeforeDiscarding("INTERNAL"), false);
  assert.equal(asksBeforeDiscarding(undefined), false);
});
