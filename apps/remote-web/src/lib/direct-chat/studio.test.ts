import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import { StudioArtCard } from "../../components/studio/StudioViewer.js";
import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";
import type { DirectChatSummary } from "./history.js";
import type {
  DirectChatAttempt,
  DirectChatConversation,
  DirectChatTranscript,
} from "./history-store.js";
import {
  filterTextConversations,
  groupByDay,
  splitPinnedAndRecent,
  studioCards,
  splitArchivedByKind,
  studioRetryModel,
  studioSubmitRefusal,
} from "./studio.js";
import type { MinihRouterModel } from "@minih-agent/shared";
const SCOPE = { gatewayRoot: "https://models.example.com", accessKeyId: "1" };

function summary(
  id: string,
  options: { isImage?: boolean; pinned?: boolean; updatedAt?: string } = {},
): DirectChatSummary {
  const conversation: DirectChatConversation = {
    id,
    scope: SCOPE,
    title: `Title ${id}`,
    createdAt: options.updatedAt ?? "2026-10-23T10:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-10-23T10:00:00.000Z",
    pinned: options.pinned ?? false,
    archived: false,
    nextModelId: "deepseek-v4",
    nextProtocol: "openai-completions",
    draft: "",
  };
  return {
    conversation,
    preview: "Preview",
    messageCount: 1,
    liveAttempt: null,
    lastFailure: null,
    isImage: options.isImage ?? false,
  };
}

function imageTranscript(
  id: string,
  attempts: DirectChatAttempt[],
  options: { archived?: boolean; prompt?: string } = {},
): DirectChatTranscript {
  const prompt = options.prompt ?? "Cyberpunk street at dusk";
  return {
    conversation: {
      id,
      scope: SCOPE,
      title: prompt,
      createdAt: "2026-10-23T10:00:00.000Z",
      updatedAt: "2026-10-23T10:00:00.000Z",
      pinned: false,
      archived: options.archived ?? false,
      nextModelId: "gpt-image-2",
      nextProtocol: "openai-images",
      draft: "",
    },
    messages: [
      {
        id: `msg-${id}`,
        conversationId: id,
        order: 1,
        role: "user",
        text: prompt,
        createdAt: "2026-10-23T10:00:00.000Z",
      },
    ],
    attempts,
    media: attempts
      .filter((a) => a.mediaIds && a.mediaIds.length > 0)
      .map((a) => ({
        id: a.mediaIds![0]!,
        scope: SCOPE,
        conversationId: id,
        attemptId: a.id,
        mime: "image/png",
        byteLength: 128,
        width: 1024,
        height: 1024,
        createdAt: a.updatedAt,
        data: new Uint8Array([1, 2, 3]),
      })),
  };
}

function imageAttempt(
  id: string,
  conversationId: string,
  state: DirectChatAttempt["state"],
  options: { startedAt?: string; mediaIds?: string[]; errorKind?: string } = {},
): DirectChatAttempt {
  const stamp = options.startedAt ?? "2026-10-23T10:00:00.000Z";
  return {
    id,
    conversationId,
    userMessageId: `msg-${conversationId}`,
    assistantMessageId: null,
    state,
    modelId: "gpt-image-2",
    modelLabel: "gpt-image-2",
    protocol: "openai-images",
    operation: "image-generation",
    startedAt: stamp,
    updatedAt: stamp,
    error: options.errorKind ? "failed" : null,
    errorKind: options.errorKind ?? null,
    usage: null,
    ...(options.mediaIds ? { mediaIds: options.mediaIds } : {}),
  };
}

describe("filterTextConversations and splitPinnedAndRecent (bug B7)", () => {
  it("excludes image conversations from the Chats list", () => {
    const rows = [
      summary("c1", { isImage: false }),
      summary("img1", { isImage: true }),
      summary("c2", { isImage: undefined }),
    ];
    expect(filterTextConversations(rows).map((r) => r.conversation.id)).toEqual(["c1", "c2"]);
  });

  it("splits text conversations into pinned and recent while keeping order", () => {
    const rows = [
      summary("p1", { pinned: true }),
      summary("p2", { pinned: true }),
      summary("r1", { pinned: false }),
    ];
    const { pinned, recent } = splitPinnedAndRecent(rows);
    expect(pinned.map((r) => r.conversation.id)).toEqual(["p1", "p2"]);
    expect(recent.map((r) => r.conversation.id)).toEqual(["r1"]);
  });
});

describe("studioCards", () => {
  it("projects generating, completed, failed, and stopped image attempts and orders generating first", () => {
    const completed = imageTranscript("c-done", [
      imageAttempt("a-done", "c-done", "complete", {
        startedAt: "2026-10-23T09:00:00.000Z",
        mediaIds: ["med-1"],
      }),
    ]);
    const generating = imageTranscript(
      "c-gen",
      [imageAttempt("a-gen", "c-gen", "pending", { startedAt: "2026-10-23T08:00:00.000Z" })],
      { prompt: "Cat on the moon" },
    );
    const failed = imageTranscript(
      "c-fail",
      [
        imageAttempt("a-fail", "c-fail", "failed", {
          startedAt: "2026-10-23T11:00:00.000Z",
          errorKind: "quota",
        }),
      ],
      { prompt: "Watercolor forest" },
    );

    const cards = studioCards([completed, generating, failed]);
    expect(cards.map((c) => [c.id, c.status])).toEqual([
      ["a-gen", "generating"],
      ["a-fail", "failed"],
      ["a-done", "complete"],
    ]);
    expect(cards[2]?.mediaId).toBe("med-1");
    expect(cards[2]?.width).toBe(1024);
  });

  it("drops a superseded failed attempt once a retry for the same prompt is in flight or complete", () => {
    const retried = imageTranscript("c-retry", [
      imageAttempt("a-1", "c-retry", "failed", {
        startedAt: "2026-10-23T09:00:00.000Z",
        errorKind: "transport",
      }),
      imageAttempt("a-2", "c-retry", "complete", {
        startedAt: "2026-10-23T09:05:00.000Z",
        mediaIds: ["med-2"],
      }),
    ]);

    const cards = studioCards([retried]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("a-2");
    expect(cards[0]?.status).toBe("complete");
  });

  it("skips archived conversations and chat-only transcripts", () => {
    const archived = imageTranscript(
      "c-arch",
      [imageAttempt("a-arch", "c-arch", "complete", { mediaIds: ["med-a"] })],
      { archived: true },
    );
    expect(studioCards([archived])).toEqual([]);
  });
});

describe("groupByDay", () => {
  it("buckets cards into today, yesterday, and explicit calendar dates", () => {
    const now = new Date("2026-10-23T18:00:00.000Z");
    const cards = studioCards([
      imageTranscript("c1", [
        imageAttempt("a1", "c1", "complete", {
          startedAt: "2026-10-23T12:00:00.000Z",
          mediaIds: ["m1"],
        }),
      ]),
      imageTranscript("c2", [
        imageAttempt("a2", "c2", "complete", {
          startedAt: "2026-10-22T15:00:00.000Z",
          mediaIds: ["m2"],
        }),
      ]),
      imageTranscript("c3", [
        imageAttempt("a3", "c3", "complete", {
          startedAt: "2026-10-18T08:00:00.000Z",
          mediaIds: ["m3"],
        }),
      ]),
    ]);

    const groups = groupByDay(cards, now);
    expect(groups.map((g) => g.day)).toEqual([
      { kind: "today" },
      { kind: "yesterday" },
      { kind: "date", isoDate: "2026-10-18", year: 2026, month: 10, day: 18 },
    ]);
  });
});

describe("StudioArtCard markup", () => {
  async function renderCard(card: ReturnType<typeof studioCards>[number], mediaUrl: string | null, revealing = false) {
    const i18n = createInstance();
    await i18n.init({
      lng: DEFAULT_LOCALE,
      resources: buildResources(),
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    return renderToStaticMarkup(
      createElement(I18nextProvider, {
        i18n,
        children: createElement(StudioArtCard, {
          card,
          mediaUrl,
          revealing,
          onOpen: () => undefined,
          onStop: () => undefined,
          onRetry: () => undefined,
          onDelete: () => undefined,
        }),
      }),
    );
  }

  it("renders generating shimmer card and completed reveal card", async () => {
    const cards = studioCards([
      imageTranscript(
        "c-gen",
        [imageAttempt("a-gen", "c-gen", "pending")],
        { prompt: "Neon alleyway" },
      ),
      imageTranscript(
        "c-done",
        [imageAttempt("a-done", "c-done", "complete", { mediaIds: ["m-1"] })],
        { prompt: "Bioluminescent jellyfish" },
      ),
    ]);

    const genHtml = await renderCard(cards[0]!, null);
    expect(genHtml).toContain("rm-image-gen");
    expect(genHtml).toContain("Generating image…");
    expect(genHtml).toContain("Neon alleyway");

    const doneHtml = await renderCard(cards[1]!, "blob:http://localhost/m-1", true);
    expect(doneHtml).toContain("rm-image-reveal");
    expect(doneHtml).toContain("Bioluminescent jellyfish");
  });
});

function model(overrides: Partial<MinihRouterModel> & { id: string }): MinihRouterModel {
  return {
    upstreamIds: [],
    vendor: "Test",
    category: "chat",
    protocols: ["openai-completions"],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: null,
    maxOutput: null,
    ...overrides,
  };
}

/**
 * Review fixes: a submit while a generation ran created a second conversation
 * (and a second bill), and a retry silently switched to whatever model was
 * selected when the original was gone.
 */
describe("Studio submit and retry decisions", () => {
  const ready = { sending: false, generating: false, hasImageModel: true, prompt: "a fox" };

  it("refuses a second submit while a generation is running", () => {
    expect(studioSubmitRefusal({ ...ready, generating: true })).toBe("busy");
    expect(studioSubmitRefusal({ ...ready, sending: true })).toBe("busy");
  });

  it("names the other reasons a submit cannot start", () => {
    expect(studioSubmitRefusal({ ...ready, hasImageModel: false })).toBe("no-model");
    expect(studioSubmitRefusal({ ...ready, prompt: "   " })).toBe("empty");
  });

  it("allows the ordinary case", () => {
    expect(studioSubmitRefusal(ready)).toBeNull();
  });

  it("retries on the model that made the picture, never the current pick", () => {
    const original = model({ id: "gpt-image-2", outputModalities: ["image"] });
    const current = model({ id: "imagen-4", outputModalities: ["image"] });
    expect(studioRetryModel([original, current], "gpt-image-2")?.id).toBe("gpt-image-2");
  });

  it("refuses when the original model is gone instead of substituting one", () => {
    const current = model({ id: "imagen-4", outputModalities: ["image"] });
    expect(studioRetryModel([current], "gpt-image-2")).toBeNull();
  });

  it("refuses when the id now names a model that cannot make images", () => {
    const textOnly = model({ id: "gpt-5", outputModalities: ["text"] });
    expect(studioRetryModel([textOnly], "gpt-5")).toBeNull();
  });
});

/**
 * Review fix: the archive kept text conversations only, and Studio hides
 * archived work, so an archived image conversation had no way back.
 */
describe("the archive keeps both kinds", () => {
  function summary(id: string, isImage: boolean): DirectChatSummary {
    return {
      conversation: {
        id,
        scope: { gatewayRoot: "https://models.example.test", accessKeyId: "42" },
        title: id,
        createdAt: "2026-10-23T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
        pinned: false,
        archived: true,
        nextModelId: isImage ? "gpt-image-2" : "gpt-5",
        nextProtocol: isImage ? "openai-images" : "openai-completions",
        draft: "",
      },
      preview: "",
      isImage,
    } as DirectChatSummary;
  }

  it("lists an archived image conversation next to the text ones", () => {
    const text = summary("conv-text", false);
    const image = summary("conv-image", true);
    const groups = splitArchivedByKind([image, text]);
    expect(groups.text.map((row) => row.conversation.id)).toEqual(["conv-text"]);
    expect(groups.images.map((row) => row.conversation.id)).toEqual(["conv-image"]);
  });

  it("has nothing to show for an empty archive", () => {
    expect(splitArchivedByKind([])).toEqual({ text: [], images: [] });
  });
});
