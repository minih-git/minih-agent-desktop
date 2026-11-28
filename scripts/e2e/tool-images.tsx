import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import { createInstance } from "i18next";
import { catalogs } from "@minih-agent/i18n";
import type { UiMessage } from "@minih-agent/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/generated-images.css";
import "../../apps/desktop/src/styles/tokens.css";

declare global {
  var toolImagesCaptureDone: boolean;
  var runToolImagesProbe: () => Promise<unknown>;
}
globalThis.runToolImagesProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } } });
  return toolImagesProbe(i18n);
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(condition: () => boolean, message: string) {
  const deadline = performance.now() + 6000;
  while (!condition() && performance.now() < deadline) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  assert(condition(), message);
}
const tick = () => new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

/**
 * Real turn rendering with fixtures only at the native file API boundary.
 *
 * A turn's tool images are a single row of small tiles, one press away from the
 * shared viewer; a generated batch keeps its large gallery. Proof, in a real
 * renderer: the row is one strip, dragging it scrolls instead of opening a
 * tile, and a failed image keeps its place.
 */
export async function toolImagesProbe(i18n: i18n) {
  const initial = useAppStore.getState();
  const read = api.fsReadImageDataUrl;
  const reads: string[] = [];
  const host = document.createElement("div");
  host.style.width = "560px";
  document.body.append(host);
  const root = createRoot(host);
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d")!;
  const image = (color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  };
  const first = { type: "image", mimeType: "image/png", data: image("#42688c") };
  const second = { ...first, data: image("#81986a") };
  const tool: UiMessage = {
    id: "read-image", role: "tool", content: "Image read", createdAt: "2026-11-27T00:00:01Z",
    toolName: "Read", toolCallId: "read-call", toolStatus: "success",
    toolArgs: { path: "/workspace/read.png" },
    toolResult: { path: "/workspace/read.png", images: [first] },
  };
  const mcp: UiMessage = {
    ...tool,
    id: "mcp-image", toolName: "mcp_screenshot", toolCallId: "mcp-call",
    toolResult: { content: [first, second], details: { images: [first, second] } },
  };
  const messages: UiMessage[] = [
    { id: "user", role: "user", content: "Show the images", createdAt: "2026-11-27T00:00:00Z" },
    tool,
    mcp,
    { id: "answer", role: "assistant", content: "Here are the images.", status: "complete", createdAt: "2026-11-27T00:00:03Z" },
  ];
  const click = (target: HTMLElement | null) => {
    assert(target, "missing interaction target");
    flushSync(() => target.click());
  };
  const renderTurn = (history: UiMessage[], isActive = false) => {
    const entry = buildTranscriptEntries(history).entries.find((item) => item.kind === "assistant-turn");
    assert(entry?.kind === "assistant-turn", "assistant turn missing");
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><AssistantTurn entry={entry} isActive={isActive} /></I18nextProvider>));
  };
  const tiles = () => [...host.querySelectorAll<HTMLButtonElement>(".tool-image-strip-item")];
  const strip = () => host.querySelector<HTMLElement>(".tool-image-strip");
  const pointer = (type: string, x: number) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: 40 });
  try {
    useAppStore.setState({ activeSessionId: "tool-images", settings: { ...initial.settings, transcriptDensity: "standard" } });
    api.fsReadImageDataUrl = async (ref) => {
      reads.push(ref);
      return ref.includes("missing") ? { kind: "missing" } : { kind: "image", dataUrl: `data:image/png;base64,${first.data}` };
    };
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      flushSync(() => root.render(null));
      renderTurn(messages);
      // One strip for the whole turn, one tile per image, and no card: Read's
      // image and the MCP call's two images share a row.
      await until(() => host.querySelectorAll(".tool-image-strip-item img").length === 3, "Read/MCP images missing from the strip");
      assert(host.querySelectorAll(".tool-images").length === 1, "each tool call made its own row");
      assert(host.querySelectorAll(".generated-image-card").length === 0, "tool images still rendered as large cards");
      assert(host.querySelector(".tool-images")?.getAttribute("aria-label") === i18n.t("chat.toolImages"), "the strip is not labelled");
      assert(tiles()[0]?.getAttribute("aria-label") === `${i18n.t("chat.toolImages")} 1`, "a tile has no accessible name");
      assert(host.querySelector('.tool-activity-header')?.getAttribute("aria-expanded") === "false", "completed process was not folded");
      click(host.querySelector(".tool-activity-header"));
      assert(tiles().length === 3, `opening details duplicated the row: ${tiles().length}`);
      click(host.querySelector(".tool-activity-header"));
      // A tile opens the shared viewer on its own image, and closing returns
      // focus to that tile.
      click(tiles()[2]);
      await until(() => !!document.querySelector("dialog.generated-image-viewer[open] img"), "tile did not open the viewer");
      const dialog = document.querySelector<HTMLDialogElement>("dialog.generated-image-viewer")!;
      assert(dialog.querySelectorAll(".generated-image-viewer-thumb").length === 3, "the viewer does not walk the whole row");
      assert(!dialog.querySelector(`button[aria-label="${i18n.t("chat.previewFile")}"]`), "inline bytes exposed a file action");
      assert(!dialog.querySelector(`button[aria-label="${i18n.t("settings.revealGeneratedImage")}"]`), "inline bytes exposed reveal action");
      await until(() => !!dialog.querySelector(".generated-image-viewer-viewport img[data-sized]"), "viewer did not decode the pressed image");
      await until(() => !!dialog.querySelector<HTMLImageElement>(".generated-image-viewer-viewport img")?.src.endsWith(second.data), "the viewer did not open the pressed image");
      const before = dialog.querySelector("output")?.textContent;
      click(dialog.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("menu.zoomIn")}"]`));
      assert(dialog.querySelector("output")?.textContent !== before, "zoom control did not change zoom");
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await until(() => !!dialog.querySelector<HTMLImageElement>(".generated-image-viewer-viewport img")?.src.endsWith(first.data), "keyboard navigation failed");
      click(dialog.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("common.close")}"]`));
      assert(!document.querySelector("dialog.generated-image-viewer"), "viewer did not close");
      assert(document.activeElement === tiles()[2], "focus did not return to the tile the viewer was opened from");
      flushSync(() => root.render(null));
      renderTurn(JSON.parse(JSON.stringify(messages)));
      await until(() => host.querySelectorAll(".tool-image-strip-item img").length === 3, "restored history lost inline images");
      renderTurn(messages, true);
      assert(host.querySelectorAll(".tool-image-strip-item").length === 3, "active turn lost image results");
    }
    assert(reads.length === 0, "inline images unexpectedly accessed local files");

    // A row wider than its container scrolls by drag, and the drag's click is
    // dropped instead of opening the tile it started on.
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...first,
      data: image(["#42688c", "#81986a", "#a4523c", "#3f6f5a", "#7a5f9c", "#9c7a3f", "#3f5f9c", "#9c3f6a"][index]),
    }));
    flushSync(() => root.render(null));
    renderTurn([
      { id: "user", role: "user", content: "Many", createdAt: "2026-11-27T00:00:00Z" },
      { ...tool, id: "read-many", toolResult: { images: many } },
      { id: "answer", role: "assistant", content: "Done", status: "complete", createdAt: "2026-11-27T00:00:03Z" },
    ]);
    await until(() => host.querySelectorAll(".tool-image-strip-item img").length === 8, "the wide row did not render");
    const boxes = tiles().map((tile) => tile.getBoundingClientRect());
    assert(new Set(boxes.map((box) => Math.round(box.top))).size === 1, "tiles are not laid out in one row");
    assert(boxes.every((box) => box.height >= 72 && box.height <= 96), `tiles are not small: ${boxes[0]?.height}px tall`);
    assert(boxes.every((box) => box.height === boxes[0]!.height && box.width === boxes[0]!.width), "tiles are not one size");
    const wide = strip()!;
    assert(wide.scrollWidth > wide.clientWidth, "the row does not overflow, so dragging cannot be proven");
    const startX = 500;
    wide.dispatchEvent(pointer("pointerdown", startX));
    window.dispatchEvent(pointer("pointermove", startX - 60));
    window.dispatchEvent(pointer("pointermove", startX - 160));
    window.dispatchEvent(pointer("pointerup", startX - 160));
    assert(wide.scrollLeft > 0, `dragging did not scroll the row (scrollLeft=${wide.scrollLeft})`);
    // The browser pairs the gesture with a click; the row drops exactly that one.
    tiles()[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    assert(!document.querySelector("dialog.generated-image-viewer"), "the click after a drag opened the viewer");
    await tick();
    flushSync(() => tiles()[3]!.click());
    await until(() => !!document.querySelector("dialog.generated-image-viewer[open]"), "a plain click stopped opening the viewer after a drag");
    click(document.querySelector<HTMLButtonElement>(`dialog.generated-image-viewer button[aria-label="${i18n.t("common.close")}"]`));

    // A tile whose bytes never decode keeps its place instead of collapsing the
    // row, and inline-only images expose no download chrome on the tile.
    flushSync(() => root.render(null));
    renderTurn([
      { id: "user", role: "user", content: "Broken", createdAt: "2026-11-27T00:00:00Z" },
      { ...tool, id: "corrupt", toolResult: { images: [{ ...first, data: "cG5n" }] } },
      { ...tool, id: "missing", toolResult: { images: [{ path: "/workspace/missing.png", mimeType: "image/png" }] } },
      { id: "answer", role: "assistant", content: "Done", status: "complete", createdAt: "2026-11-27T00:00:03Z" },
    ]);
    await until(() => host.querySelectorAll(".tool-image-strip-item.is-unavailable").length === 2, "failed images did not keep their place");
    assert(tiles().length === 2, "a failed image collapsed the row");
    assert(reads.includes("/workspace/missing.png"), "a missing reference was not read through the host");
    assert(!host.querySelector(".tool-image-strip a[download]"), "tiles expose download chrome");
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      flushSync(() => root.render(null));
      renderTurn([
        { id: "user", role: "user", content: "Broken", createdAt: "2026-11-27T00:00:00Z" },
        { ...tool, id: "corrupt", toolResult: { images: [{ ...first, data: "cG5n" }] } },
        { id: "answer", role: "assistant", content: "Done", status: "complete", createdAt: "2026-11-27T00:00:03Z" },
      ]);
      await until(() => host.textContent?.includes(i18n.t("chat.imagePreview.error")) ?? false, "the failed tile has no accessible text");
    }

    // A generated batch is the answer, not evidence: it keeps the large gallery.
    flushSync(() => root.render(null));
    for (const path of ["/scratch/generated.png", "/scratch/edited.png"]) {
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, id: `generated-${path}`, toolName: "GenerateImages", toolResult: { details: {
        kind: "generated-images", results: [{ status: "succeeded", path, mimeType: "image/png" }, { status: "failed", errorCode: "IMAGE_TIMEOUT" }],
      } } }} /></I18nextProvider>));
      await until(() => (host.querySelector<HTMLImageElement>(".generated-image-card img")?.naturalWidth ?? 0) > 0, "generated image did not decode into the large gallery");
      assert(host.querySelectorAll(".tool-image-strip-item").length === 0, "a generated batch was reduced to a strip tile");
      assert(host.textContent?.includes("IMAGE_TIMEOUT"), "partial generation failure disappeared");
      assert(host.querySelector<HTMLAnchorElement>(".generated-image-card a[download]")?.href.endsWith(first.data), "generated download target changed");
    }
    // The same projection outside a turn: a plugin's image resource is a strip
    // tile, and a local reference goes through the contained host reader.
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, toolName: "plugin_image", toolResult: {
      content: [{ type: "resource", resource: { mimeType: "image/png", blob: first.data } }],
    } }} /></I18nextProvider>));
    await until(() => tiles().length === 1 && !!tiles()[0]?.querySelector("img"), "plugin resource lost its image");
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, toolResult: {
      images: [{ path: "/workspace/explicit.png", mimeType: "image/png" }],
    } }} /></I18nextProvider>));
    await until(() => reads.includes("/workspace/explicit.png"), "file reference bypassed contained image reader");
    await until(() => (tiles()[0]?.querySelector<HTMLImageElement>("img")?.naturalWidth ?? 0) > 0, "local image reference did not decode in the strip");

    renderTurn(messages);
    await until(() => host.querySelectorAll(".tool-image-strip-item img").length === 3 && [...host.querySelectorAll<HTMLImageElement>(".tool-image-strip-item img")].every((image) => image.naturalWidth > 0), "snapshot images did not decode");
    console.log("TOOL_IMAGES_CAPTURE");
    await until(() => globalThis.toolImagesCaptureDone, "screenshot was not captured");
    return { ok: true, locales: ["en", "zh-CN"], scenarios: ["read", "mcp-batch", "one-strip-per-turn", "collapsed-turn", "active-turn", "tile-opens-viewer", "viewer-navigation-zoom", "focus-return", "drag-scroll", "drag-suppresses-click", "failed-placeholder", "history-restore", "generated-gallery", "plugin-resource", "contained-reference"] };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.fsReadImageDataUrl = read;
    useAppStore.setState({ activeSessionId: initial.activeSessionId, settings: initial.settings });
  }
}
