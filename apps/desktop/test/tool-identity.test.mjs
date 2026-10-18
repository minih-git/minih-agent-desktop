import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { getToolIdentity } = await import("../src/lib/tool-identity.ts");

test("Skill identity uses the exact supplied id and supported history aliases", () => {
  for (const key of ["id", "skill", "name"]) {
    assert.deepEqual(getToolIdentity("functions.Skill", { [key]: "publisher/my-skill" }),
      { kind: "skill", name: "publisher/my-skill" });
  }
  assert.deepEqual(getToolIdentity("Skill", { id: "current", skill: "old" }), { kind: "skill", name: "current" });
  for (const args of [undefined, null, {}, [], { id: 3 }, { id: " " }, "partial"]) {
    assert.deepEqual(getToolIdentity("Skill", args), { kind: "skill", name: "Skill" });
  }
});

test("extension identity preserves qualified names without guessing owner boundaries", () => {
  for (const name of ["mcp_personal_knowledge_knowledge_read", "mcp__server__read", "functions.mcp_server_read"]) {
    assert.deepEqual(getToolIdentity(name, {}), { kind: "mcp", name });
  }
  for (const name of ["plugin_demo_hello_echo_text", "plugin_demo_hello_files_read_file"]) {
    assert.deepEqual(getToolIdentity(name, {}), { kind: "plugin", name });
  }
  assert.deepEqual(getToolIdentity("CustomTool", {}), { kind: "tool", name: "CustomTool" });
  assert.deepEqual(getToolIdentity("SkillSearch", {}), null);
});

test("built-in actions and absent names keep their existing presentation", () => {
  for (const name of [undefined, "", "Read", "Bash", "Grep", "Write", "Task", "TaskWait", "TodoWrite"]) {
    assert.equal(getToolIdentity(name, {}), null);
  }
});
