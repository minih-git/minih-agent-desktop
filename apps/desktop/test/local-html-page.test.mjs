import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_HTML_PAGE_SOURCE_LENGTH,
  isLocalHtmlPageLink,
  loadLocalHtmlPage,
  localHtmlPageFromRead,
  localHtmlPageLinkPath,
  localHtmlPagePath,
} from "../src/lib/html-page.ts";

/*
 * A chat link to a local `.html` page becomes the page itself in an answer
 * surface, so what the link points at and which reads may become a page are
 * decisions with security weight: only the local machine, only `.html`, only
 * `text` the cap allows.
 */

test("a file link resolves to the path it names", () => {
  assert.equal(localHtmlPagePath("file:///tmp/report.html"), "/tmp/report.html");
  assert.equal(
    localHtmlPagePath("file:///Users/minih/My Pages/a b.html"),
    "/Users/minih/My Pages/a b.html",
  );
  assert.equal(
    localHtmlPagePath("file:///Users/minih/My%20Pages/a%20b.html"),
    "/Users/minih/My Pages/a b.html",
  );
  assert.equal(localHtmlPagePath("file://localhost/tmp/a.html"), "/tmp/a.html");
  assert.equal(localHtmlPagePath("file:///C:/work/page.html"), "C:/work/page.html");
  // A cache-busting query is part of the link, not of the file name.
  assert.equal(localHtmlPagePath("file:///tmp/a.html?v=2"), "/tmp/a.html");
  assert.equal(localHtmlPagePath("file:///tmp/a.html#top"), "/tmp/a.html");
});

test("only the local machine and a plain file URL resolve", () => {
  for (const href of [
    "https://example.com/page.html",
    "file://fileserver/share/page.html",
    "file://",
    "/tmp/page.html",
    "",
  ]) {
    assert.equal(localHtmlPagePath(href), null, href);
  }
  // A broken escape names no file the host could read.
  assert.equal(localHtmlPagePath("file:///tmp/%E0%A4%A.html"), null);
});

test("only .html links are pages", () => {
  assert.equal(isLocalHtmlPageLink("file:///tmp/report.html"), true);
  assert.equal(isLocalHtmlPageLink("file:///tmp/report.htm"), true);
  assert.equal(isLocalHtmlPageLink("file:///tmp/report.HTML"), true);
  assert.equal(isLocalHtmlPageLink("file:///tmp/notes.md"), false);
  assert.equal(isLocalHtmlPageLink("https://example.com/report.html"), false);
  assert.equal(isLocalHtmlPageLink("file://fileserver/report.html"), false);
});

test("a rewritten file destination is still the same local page", () => {
  // The Markdown renderer drops the scheme and percent-encodes the rest before
  // a component sees it, so the encoded form has to resolve to the same file.
  assert.equal(localHtmlPageLinkPath("%2Ftmp%2Freport.html"), "/tmp/report.html");
  assert.equal(localHtmlPageLinkPath("/tmp/report.html"), "/tmp/report.html");
  assert.equal(localHtmlPageLinkPath("file:///tmp/report.html"), "/tmp/report.html");

  // A relative link keeps its existing destination: it names a file the
  // transcript opens, not a page the answer renders in place.
  for (const href of [
    "report.html",
    "./report.html",
    "notes.md",
    "https://example.com/a.html",
  ]) {
    assert.equal(localHtmlPageLinkPath(href), null, href);
  }
});

test("a text read within the cap renders, everything else keeps the link", () => {
  const ready = localHtmlPageFromRead({ kind: "text", content: "<p>hi</p>", size: 9 });
  assert.deepEqual(ready, { status: "ready", code: "<p>hi</p>" });

  for (const result of [
    null,
    { kind: "binary", size: 20 },
    { kind: "tooLarge", size: 900_000 },
    { kind: "image", dataUrl: "data:image/png;base64,AA", size: 3 },
    { kind: "text", content: "   ", size: 3 },
    { kind: "text", size: 0 },
  ]) {
    assert.deepEqual(localHtmlPageFromRead(result), { status: "unavailable" });
  }
});

test("the page cap is the fence cap, inclusive at the boundary", () => {
  const atCap = "x".repeat(MAX_HTML_PAGE_SOURCE_LENGTH);
  assert.equal(
    localHtmlPageFromRead({ kind: "text", content: atCap, size: atCap.length }).status,
    "ready",
  );
  assert.deepEqual(
    localHtmlPageFromRead({ kind: "text", content: `${atCap}x`, size: atCap.length + 1 }),
    { status: "unavailable" },
  );
});

test("one read decides the page, and a rejected read is not a page", async () => {
  let reads = 0;
  const page = await loadLocalHtmlPage(async () => {
    reads += 1;
    return { kind: "text", content: "<h1>done</h1>", size: 13 };
  });
  assert.deepEqual(page, { status: "ready", code: "<h1>done</h1>" });
  assert.equal(reads, 1);

  assert.deepEqual(
    await loadLocalHtmlPage(async () => {
      throw new Error("path outside allowed roots");
    }),
    { status: "unavailable" },
  );
  assert.deepEqual(await loadLocalHtmlPage(async () => null), { status: "unavailable" });
});