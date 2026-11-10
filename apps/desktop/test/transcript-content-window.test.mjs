import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { hasStatefulTranscriptContent, shouldMountTranscriptContent } = await import("../src/lib/transcript-content-window.ts");
const box = { top: 0, bottom: 200, viewportHeight: 600, width: 600,
  measuredHeight: 200, measuredWidth: 600, mounted: true, protected: false };

test("stateful Markdown and inline HTML keep their renderer and preview state", () => {
  for (const source of ["```mermaid\ngraph TD; A-->B\n```", "~~~js\ncode\n~~~", "|a|b|\n|-|-|", "<html><body>page</body></html>", "<div>interactive</div>", "![plot](image.png)"]) {
    assert.equal(hasStatefulTranscriptContent(source), true, source);
  }
  assert.equal(hasStatefulTranscriptContent("Ordinary prose with `inline code`."), false);
});

test("only measured offscreen prose can release its renderer", () => {
  assert.equal(shouldMountTranscriptContent({ ...box, top: -4000, bottom: -3800 }), false);
  assert.equal(shouldMountTranscriptContent({ ...box, top: 4000, bottom: 4200 }), false);
  assert.equal(shouldMountTranscriptContent({ ...box, top: -4000, bottom: 20 }), true);
  for (const changed of [{ measuredHeight: null }, { width: 400 }, { protected: true }, { viewportHeight: 0 }]) {
    assert.equal(shouldMountTranscriptContent({ ...box, top: -4000, bottom: -3800, ...changed }), true);
  }
});

test("entry and exit buffers keep boundary content stable", () => {
  assert.equal(shouldMountTranscriptContent({ ...box, top: -2600, bottom: -2400 }), true);
  assert.equal(shouldMountTranscriptContent({ ...box, top: -2600, bottom: -2400, mounted: false }), false);
  assert.equal(shouldMountTranscriptContent({ ...box, top: -1700, bottom: -1500, mounted: false }), true);
});
