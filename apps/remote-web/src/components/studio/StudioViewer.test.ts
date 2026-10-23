import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";
import type { StudioCard } from "../../lib/direct-chat/studio.js";
import { StudioArtCard, StudioViewerModal } from "./StudioViewer.js";

/**
 * The Studio gallery card and its full-screen viewer (ADR mobile-redesign D3,
 * D4): the caption must stay inside the card that holds it, and the viewer must
 * be a real modal dialog that owns focus while it is open.
 */
const CARD: StudioCard = {
  id: "a-1",
  conversationId: "c-1",
  attemptId: "a-1",
  prompt: "Bioluminescent jellyfish",
  modelId: "gpt-image-2",
  createdAt: "2026-10-23T10:00:00.000Z",
  status: "complete",
  mediaId: "m-1",
  width: 1024,
  height: 1024,
  errorKind: null,
  error: null,
  attempt: {
    id: "a-1",
    conversationId: "c-1",
    userMessageId: "msg-1",
    assistantMessageId: null,
    state: "complete",
    modelId: "gpt-image-2",
    modelLabel: "GPT Image 2",
    protocol: "openai-images",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    error: null,
    errorKind: null,
    usage: null,
    mediaIds: ["m-1"],
    operation: "image-generation",
    imagePrompt: "Bioluminescent jellyfish",
  },
};

async function render(element: ReturnType<typeof createElement>): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng: DEFAULT_LOCALE,
    resources: buildResources(),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n, children: element }));
}

/** The opening tag of the first `tag` in the markup, attributes included. */
function openTag(html: string, tag: string): string {
  const start = html.indexOf(tag);
  if (start === -1) return "";
  return html.slice(start, html.indexOf(">", start) + 1);
}

describe("StudioArtCard caption", () => {
  it("keeps the caption inside a positioned gallery card", async () => {
    const html = await render(
      createElement(StudioArtCard, {
        card: CARD,
        mediaUrl: "blob:http://localhost/m-1",
        onOpen: () => undefined,
        onStop: () => undefined,
        onRetry: () => undefined,
        onDelete: () => undefined,
      }),
    );

    // The caption is `absolute bottom-0`, so the card has to be its containing
    // block (`relative`) and clip it (`overflow-hidden`); without the first, the
    // caption escaped the masonry column it belongs to.
    const card = openTag(html, "<button");
    expect(card).toContain("relative");
    expect(card).toContain("overflow-hidden");

    const caption = html.indexOf("absolute inset-x-0 bottom-0");
    expect(caption).toBeGreaterThan(html.indexOf("<img"));
    expect(html.lastIndexOf("</button>")).toBeGreaterThan(caption);
  });
});

describe("StudioViewerModal", () => {
  it("renders as a modal dialog labelled by the prompt", async () => {
    const html = await render(
      createElement(StudioViewerModal, {
        card: CARD,
        mediaUrl: "blob:http://localhost/m-1",
        onClose: () => undefined,
        onReusePrompt: () => undefined,
        onDelete: () => undefined,
        onToast: () => undefined,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Bioluminescent jellyfish"');
  });

  it("puts the close button first, so opening moves focus to it", async () => {
    const html = await render(
      createElement(StudioViewerModal, {
        card: CARD,
        mediaUrl: "blob:http://localhost/m-1",
        onClose: () => undefined,
        onReusePrompt: () => undefined,
        onDelete: () => undefined,
        onToast: () => undefined,
      }),
    );
    const firstButton = openTag(html, "<button");
    expect(firstButton).toContain('aria-label="Close"');
    expect(html.indexOf("<button")).toBeLessThan(html.indexOf("<img"));
  });

  it("renders nothing when there is no artwork to show", async () => {
    const html = await render(
      createElement(StudioViewerModal, {
        card: null,
        mediaUrl: null,
        onClose: () => undefined,
        onReusePrompt: () => undefined,
        onDelete: () => undefined,
        onToast: () => undefined,
      }),
    );
    expect(html).toBe("");
  });
});