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

/** Real turn rendering with fixtures only at the native file API boundary. */
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
  const messages: UiMessage[] = [
    { id: "user", role: "user", content: "Show the images", createdAt: "2026-11-27T00:00:00Z" },
    tool,
    { ...tool, id: "mcp-image", toolName: "mcp_screenshot", toolCallId: "mcp-call", toolResult: {
      content: [first, second], details: { images: [first, second] },
    } },
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
      await until(() => host.querySelectorAll(".generated-image-card img").length === 2, "Read/MCP images hidden in collapsed turn");
      assert(host.querySelectorAll(".generated-image-thumb").length === 2, "MCP mirrors duplicated images");
      assert(host.querySelector('.tool-activity-header')?.getAttribute("aria-expanded") === "false", "completed process was not folded");
      click(host.querySelector(".tool-activity-header"));
      assert(host.querySelectorAll(".generated-image-card").length === 2, "opening details duplicated galleries");
      click(host.querySelector(".tool-activity-header"));
      const gallery = host.querySelectorAll<HTMLElement>(".generated-images")[1];
      const thumbs = gallery.querySelectorAll<HTMLButtonElement>(".generated-image-thumb");
      click(thumbs[1]);
      const selected = gallery.querySelector<HTMLImageElement>(".generated-image-preview img");
      assert(selected?.src.endsWith(second.data), "thumbnail did not select the second image");
      const download = gallery.querySelector<HTMLAnchorElement>("a[download]");
      assert(download?.href === selected.src && download.download.endsWith(".png"), "download does not target selected image");
      click(gallery.querySelector(".generated-image-preview"));
      await until(() => !!document.querySelector("dialog.generated-image-viewer[open] img[data-sized]"), "viewer did not decode inline image");
      const dialog = document.querySelector<HTMLDialogElement>("dialog.generated-image-viewer")!;
      assert(!dialog.querySelector(`button[aria-label="${i18n.t("chat.previewFile")}"]`), "inline bytes exposed a file action");
      assert(!dialog.querySelector(`button[aria-label="${i18n.t("settings.revealGeneratedImage")}"]`), "inline bytes exposed reveal action");
      const before = dialog.querySelector("output")?.textContent;
      click(dialog.querySelector(`button[aria-label="${i18n.t("menu.zoomIn")}"]`));
      assert(dialog.querySelector("output")?.textContent !== before, "zoom control did not change zoom");
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await until(() => !!dialog.querySelector<HTMLImageElement>(".generated-image-viewer-viewport img")?.src.endsWith(first.data), "keyboard navigation failed");
      click(dialog.querySelector(`button[aria-label="${i18n.t("common.close")}"]`));
      assert(!document.querySelector("dialog.generated-image-viewer"), "viewer did not close");
      assert(gallery.querySelector<HTMLImageElement>(".generated-image-preview img")?.src.endsWith(first.data), "viewer selection was not retained in chat");
      flushSync(() => root.render(null));
      renderTurn(JSON.parse(JSON.stringify(messages)));
      await until(() => host.querySelectorAll(".generated-image-card img").length === 2, "restored history lost inline images");
      renderTurn(messages, true);
      assert(host.querySelectorAll(".generated-image-card").length === 2, "active turn lost image results");
    }
    assert(reads.length === 0, "inline images unexpectedly accessed local files");
    // A standalone tool row (including plugin fallbacks) uses the same gallery.
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, toolName: "plugin_image", toolResult: {
      content: [{ type: "resource", resource: { mimeType: "image/png", blob: first.data } }],
    } }} /></I18nextProvider>));
    assert(host.querySelectorAll(".generated-image-card").length === 1, "plugin resource fallback lost image");
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, toolResult: {
      images: [{ path: "/workspace/explicit.png", mimeType: "image/png" }],
    } }} /></I18nextProvider>));
    await until(() => reads.includes("/workspace/explicit.png"), "file reference bypassed contained image reader");
    await until(() => (host.querySelector<HTMLImageElement>(".generated-image-card img")?.naturalWidth ?? 0) > 0, "local image reference did not decode");
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, toolResult: {
      images: [{ ...first, data: "cG5n" }],
    } }} /></I18nextProvider>));
    await until(() => !!host.textContent?.includes(i18n.t("settings.imagePreviewUnavailable")), "corrupt image did not show unavailable state");
    assert(!host.querySelector("a[download]"), "corrupt image retained download action");
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, toolResult: {
      path: "/workspace/missing.png",
    } }} /></I18nextProvider>));
    await until(() => reads.includes("/workspace/missing.png"), "missing reference was not checked");
    assert(!host.querySelector("a[download]"), "missing image exposed download action");
    for (const path of ["/scratch/generated.png", "/scratch/edited.png"]) {
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><ToolRow message={{ ...tool, toolName: "GenerateImages", toolResult: { details: {
        kind: "generated-images", results: [{ status: "succeeded", path, mimeType: "image/png" }, { status: "failed", errorCode: "IMAGE_TIMEOUT" }],
      } } }} /></I18nextProvider>));
      await until(() => (host.querySelector<HTMLImageElement>(".generated-image-card img")?.naturalWidth ?? 0) > 0, "generated/edited image did not decode");
      assert(host.textContent?.includes("IMAGE_TIMEOUT"), "partial generation failure disappeared");
      assert(host.querySelector<HTMLAnchorElement>("a[download]")?.href.endsWith(first.data), "generated download target changed");
    }
    renderTurn(messages);
    await until(() => host.querySelectorAll(".generated-image-card img").length === 2 && [...host.querySelectorAll<HTMLImageElement>(".generated-image-card img")].every((image) => image.naturalWidth > 0), "snapshot images did not decode");
    console.log("TOOL_IMAGES_CAPTURE");
    await until(() => globalThis.toolImagesCaptureDone, "screenshot was not captured");
    return { ok: true, locales: ["en", "zh-CN"], scenarios: ["read", "mcp-batch", "plugin-resource", "collapsed-turn", "active-turn", "viewer-navigation-zoom", "download-target", "history-restore", "contained-reference", "corrupt-and-missing", "generated-edit-partial-failure"] };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.fsReadImageDataUrl = read;
    useAppStore.setState({ activeSessionId: initial.activeSessionId, settings: initial.settings });
  }
}
