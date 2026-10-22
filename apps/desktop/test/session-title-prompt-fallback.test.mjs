/**
 * Automatic session titles have two layers: host-core derives a deterministic
 * title from the first prompt so a new session is readable offline, and an
 * optional title plugin may later upgrade it with a model-composed title.
 * These tests lock both halves and the boundary between them.
 */
import { readMainSource, readStoreSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import i18n from "i18next";
import { catalogs } from "@minih-agent/i18n";
import {
  isDefaultSessionTitle,
  promptFallbackSessionTitle,
  untitledTaskTitle,
} from "../src/lib/session-title-utils.ts";

// The helper reads the app's i18n singleton, so initialize it with the real
// English catalog instead of leaving `t()` returning keys.
await i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
});
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [api, protocol, host, rpc, queueSlice, main, store] = await Promise.all([
  read("../src/lib/api.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../crates/host-core/src/sessions.rs"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
  read("../src/stores/slices/queue-slice.ts"),
  readMainSource(),
  readStoreSource(),
]);
test("a prompt that is only a pasted chip is never named after its path", () => {
  const pastedChip = "@/Users/minih/.minih-agent-desktop/scratch/e94e3/pasted/pasted-a1b2.txt";
  // The old fallback sliced the raw prompt, so the sidebar showed the scratch
  // path as the task name until something else renamed it.
  assert.equal(promptFallbackSessionTitle(pastedChip, "New task"), "New task");
  assert.equal(promptFallbackSessionTitle(`${pastedChip} 总结这份文档`, "New task"), "总结这份文档");
  assert.equal(
    promptFallbackSessionTitle('@"/tmp/a b/notes.md" compare @src/a.ts', "New task"),
    "compare",
  );
});

test("a generated or refreshed title reaches the sidebar and the remote client", () => {
  // The host write alone is invisible: the renderer keeps its own session list,
  // so Electron main must announce the change after the compare-and-set lands.
  // A phone holding the session learns it from RACP instead, so the same
  // callback also announces it to the Agent Host through the notifier.
  assert.match(
    main,
    /onTitleChanged: \(sessionId\) => \{\s*sendToRenderer\(IPC\.event\.sessionsChanged, \{ reason: "session\.title" \}\);\s*void sessionChangeNotifier\.titleChanged\(sessionId\);\s*\}/,
  );
  assert.match(main, /createSessionTitleGenerator\(\{[\s\S]{0,600}dataDir,/);
  assert.match(main, /createSessionRetitleGenerator\(\{[\s\S]{0,700}onTitleChanged/);
  // Every entrance that writes a title in Main goes through one path: the two
  // generators, the plugin service hook, and the rename/derive IPC hook.
  assert.equal(main.match(/sessionChangeNotifier\.titleChanged\(/g)?.length, 4);
});

test("one generator instance serves the send path and the settled-turn retry", () => {
  // Two instances would each hold their own run registry, so a retry could race
  // the composition it is meant to complete and spend a second model call.
  // The helper's own declaration is the other match; only index.ts constructs it.
  assert.equal(main.match(/= createSessionTitleGenerator\(/g)?.length, 1);
  assert.match(main, /const sessionTitleGenerator = createSessionTitleGenerator\(\{/);
  assert.equal(main.match(/sessionTitleGenerator\.run,/g)?.length, 2);
  assert.match(main, /generateSessionTitle: sessionTitleGenerator\.run,/);
  assert.match(main, /isSessionTitleRunning: sessionTitleGenerator\.isRunning,/);
  assert.match(main, /whenSessionTitleIdle: sessionTitleGenerator\.whenIdle,/);
  assert.match(
    main,
    /generateSessionTitleJob &&[\s\S]{0,200}event\.type === "agent_end"[\s\S]{0,900}MAX_TITLE_RETRIES/,
  );
  assert.match(main, /await whenSessionTitleIdle\?\.\(retrySessionId\)/);
  assert.match(main, /MAX_TITLE_RETRIES = 2/);
});

test("the first prompt becomes an immediate title, collapsed and capped", () => {
  assert.equal(promptFallbackSessionTitle("  Fix\n the\tlogin  ", "New task"), "Fix the login");
  assert.equal(promptFallbackSessionTitle("p".repeat(60), "New task"), "p".repeat(48));
  assert.equal(promptFallbackSessionTitle("   ", "New task"), "New task");
  assert.equal(promptFallbackSessionTitle("界".repeat(60), "New task"), "界".repeat(48));
});

test("the fallback only fires for a still-untitled session the owning host can title", () => {
  assert.equal(isDefaultSessionTitle(promptFallbackSessionTitle("Fix login", "New task")), false);
  assert.equal(isDefaultSessionTitle(untitledTaskTitle()), true);
  // A placeholder is recognized in every shipped locale, not just the active one.
  for (const placeholder of [
    "새 작업",
    "新建任務",
    "Tarefa sem título",
    "Yeni görev",
    "New chat",
  ]) {
    assert.equal(isDefaultSessionTitle(placeholder), true, placeholder);
  }
  assert.match(queueSlice, /isDefaultSessionTitle\(current\?\.title\)/);
  assert.match(queueSlice, /current\?\.source !== "pi-native"/);
  // A remote session derives on its own host through this same call — the
  // backend router forwards it to the owning `agent-host-cli` — so the gate must not
  // exclude remote ids: doing so left every remote task unnamed.
  assert.doesNotMatch(queueSlice, /!isRemoteSession\(/);
  assert.doesNotMatch(
    queueSlice,
    /isDefaultSessionTitle\(current\?\.title\)[\s\S]{0,200}source !== "remote"/,
  );
  assert.match(queueSlice, /api\s+\.deriveSessionTitle\(sessionId, nextTitle\)/);
  assert.match(queueSlice, /if \(!isDefaultSessionTitle\(nextTitle\)\)/);
});

test("the fallback travels the existing ipc bridge into host-core", () => {
  assert.match(protocol, /sessionDeriveTitle: "minih-agent-desktop\/session\/deriveTitle"/);
  assert.match(api, /invoke<\{ updated: boolean \}>\(IPC\.invoke\.sessionDeriveTitle, id, title\)/);
  assert.match(main, /handle\(IPC\.invoke\.sessionDeriveTitle/);
  assert.match(main, /host\.call\("session\.deriveTitle", \{ id, title \}\)/);
  assert.match(rpc, /"session\.deriveTitle" => \{/);
  assert.match(rpc, /sessions::derive_session_title\(&st\.db, id, &title\)/);
});

test("host-core keeps a derived title replaceable and never touches a named one", () => {
  const deriveStart = host.indexOf("pub fn derive_session_title");
  const deriveBody = host.slice(deriveStart, host.indexOf("pub fn auto_title_context"));
  assert.ok(deriveStart > 0, "derive_session_title must exist");
  // The derived text must stay an automatic title: a plugin may still replace
  // it, so only the title moves and the source stays `default`.
  assert.match(deriveBody, /UPDATE sessions SET title = \?1/);
  assert.doesNotMatch(deriveBody, /title_source = \?1/);
  assert.doesNotMatch(deriveBody, /TITLE_SOURCE_MANUAL/);
  assert.match(deriveBody, /AND title = \?3 AND title_source = \?4 AND deleted_at IS NULL/);
  assert.match(deriveBody, /title_source != TITLE_SOURCE_DEFAULT \|\| !is_default_title\(&current_title\)/);
  assert.match(host, /fn derived_prompt_title_stays_eligible_for_the_title_plugin/);
  assert.match(host, /fn derived_prompt_title_never_overrides_named_sessions/);
});

test("automatic AI titles stay plugin-owned", () => {
  assert.doesNotMatch(api, /summarizeSessionTitle/);
  assert.doesNotMatch(store, /triggerAutoTitleSummarization/);
  assert.doesNotMatch(main, /IPC\.invoke\.sessionSummarizeTitle/);
});
