import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
test("the host delegates title policy to plugins and retains only bounded capabilities", async () => {
  const [entry, send, events, panel] = await Promise.all([
    read("../electron/main/index.ts"),
    read("../electron/main/ipc/agent-ipc.ts"),
    read("../electron/main/runtime/sidecar.ts"),
    read("../src/features/settings/panels/ai-panels.tsx"),
  ]);
  assert.doesNotMatch(entry, /createSessionTitleGenerator|createSessionRetitleGenerator/);
  assert.doesNotMatch(send, /generateSessionTitle/);
  assert.doesNotMatch(events, /generateSessionTitle|generateSessionRetitle/);
  assert.doesNotMatch(panel, /SessionTitle(?:Toggle|Model|Thinking)Row/);
  assert.match(send, /announcePromptSent\?\.\(\{ sessionId: req.sessionId, turnId: durableTurnId \}\)/);
  assert.match(events, /session:compacted/);
});
