import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

let server;
let createInteractionSlice;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ createInteractionSlice } = await server.ssrLoadModule("/src/stores/slices/interaction-slice.ts"));
});
after(async () => { await server?.close(); });

function fixture() {
  let state = { toasts: [] };
  let id = 0;
  const actions = createInteractionSlice({
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    runtime: {},
    interactionRuntime: { nextToastId: () => ++id },
  });
  return { ...actions, get: () => state.toasts };
}

test("warnings and errors stay until dismissed; success and information expire", () => {
  const state = fixture();
  for (const variant of ["info", "success", "warning", "error"]) {
    state.showToast(variant, { variant });
  }
  assert.deepEqual(state.get().map(({ variant, duration }) => [variant, duration]), [
    ["info", 4000], ["success", 4000], ["warning", 0], ["error", 0],
  ]);
});

test("explicit durations and prompt reminder metadata remain compatible", () => {
  const state = fixture();
  state.showToast("Waiting for an answer", { duration: 0, sound: false, sessionId: "chat-a", promptRequestId: "ask-a" });
  state.showToast("Temporary error", { variant: "error", duration: 1200 });
  assert.deepEqual(state.get(), [
    { id: 1, message: "Waiting for an answer", variant: "info", duration: 0, sound: false, sessionId: "chat-a", promptRequestId: "ask-a" },
    { id: 2, message: "Temporary error", variant: "error", duration: 1200, sound: true, sessionId: undefined, promptRequestId: undefined },
  ]);
});

test("new notices never evict a sticky notification; transient queue stays bounded", () => {
  const state = fixture();
  for (let index = 0; index < 6; index++) {
    state.showToast(`Error ${index}`, { variant: "error" });
  }
  state.showToast("Answer needed", { duration: 0, sessionId: "chat-a", promptRequestId: "ask-a" });
  for (let index = 0; index < 6; index++) state.showToast(`Saved ${index}`, { variant: "success" });
  assert.equal(state.get().filter((item) => item.duration === 0).length, 7);
  assert.deepEqual(state.get().filter((item) => item.duration > 0).map((item) => item.message),
    ["Saved 2", "Saved 3", "Saved 4", "Saved 5"]);
  assert.deepEqual(state.get().map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13]);
});

test("repeat messages replace only the matching variant and conversation", () => {
  const state = fixture();
  state.showToast("Try again", { variant: "error", sessionId: "chat-a" });
  state.showToast("Try again", { variant: "error", sessionId: "chat-b" });
  state.showToast("Try again", { variant: "warning", sessionId: "chat-a" });
  state.showToast("Try again", { variant: "error", sessionId: "chat-a" });
  assert.deepEqual(state.get().map((item) => [item.id, item.variant, item.sessionId]), [
    [2, "error", "chat-b"], [3, "warning", "chat-a"], [4, "error", "chat-a"],
  ]);
});

test("dismiss removes only the selected notification and keeps raw error detail", () => {
  const state = fixture();
  const detail = "Save failed: storage is read-only.\nRequest id: abc-123";
  state.showToast(detail, { variant: "error" });
  state.showToast("Needs review", { variant: "warning" });
  state.dismissToast(state.get()[1].id);
  assert.equal(state.get().length, 1);
  assert.equal(state.get()[0].message, detail);
  state.dismissToast(999);
  assert.equal(state.get().length, 1);
});
