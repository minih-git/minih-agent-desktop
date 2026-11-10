import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { observeTranscriptContent } = await import("../src/lib/transcript-content-observer.ts");

test("one viewport shares a frame and detaches all observation at its last subscriber", () => {
  const frames = new Map(); const observers = []; let next = 0;
  const original = { ResizeObserver:globalThis.ResizeObserver, requestAnimationFrame:globalThis.requestAnimationFrame, cancelAnimationFrame:globalThis.cancelAnimationFrame };
  globalThis.ResizeObserver = class {
    targets = new Set(); disconnected = false;
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
  };
  globalThis.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  try {
    const viewport = new EventTarget(); viewport.ownerDocument = new EventTarget();
    const element = () => ({ closest: () => viewport });
    let first = 0; let second = 0;
    const a = observeTranscriptContent(element(), () => first++);
    const b = observeTranscriptContent(element(), () => second++);
    assert.equal(observers.length, 1); assert.equal(frames.size, 1);
    viewport.dispatchEvent(new Event("scroll")); viewport.ownerDocument.dispatchEvent(new Event("selectionchange"));
    const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback());
    assert.equal(first, 1); assert.equal(second, 1);
    a(); assert.equal(observers[0].disconnected, false);
    viewport.dispatchEvent(new Event("scroll")); assert.equal(frames.size, 1);
    b(); assert.equal(observers[0].disconnected, true); assert.equal(frames.size, 0);
    viewport.dispatchEvent(new Event("focusin")); viewport.ownerDocument.dispatchEvent(new Event("selectionchange"));
    assert.equal(frames.size, 0);
  } finally { Object.assign(globalThis, original); }
});
