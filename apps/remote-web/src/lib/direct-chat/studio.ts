/**
 * Pure projection rules for the Chats text filter and the Studio gallery
 * (ADR mobile-redesign D3, bug B7).
 *
 * Before D3, the Chats screen filtered `isImage === true` only when the
 * "Images" segment was selected and left image conversations mixed into the
 * "Chats" list (bug B7). Separating the two roots means:
 *
 * - Chats lists text conversations only (`filterTextConversations`), split into
 *   pinned cards and recent rows (`splitPinnedAndRecent`).
 * - Studio projects image conversations' attempts and saved media into gallery
 *   cards (`studioCards`), ordered newest first and grouped by calendar day
 *   (`groupByDay`).
 */
import { isImageAttempt, type DirectChatSummary } from "./history.js";
import type {
  DirectChatAttempt,
  DirectChatMedia,
  DirectChatTranscript,
} from "./history-store.js";

/** Keep only text conversations for the Chats root (fixes bug B7). */
export function filterTextConversations(
  rows: readonly DirectChatSummary[],
): DirectChatSummary[] {
  return rows.filter((row) => row.isImage !== true);
}

/** Split text conversations into pinned cards and recent rows. */
export function splitPinnedAndRecent(rows: readonly DirectChatSummary[]): {
  pinned: DirectChatSummary[];
  recent: DirectChatSummary[];
} {
  const pinned: DirectChatSummary[] = [];
  const recent: DirectChatSummary[] = [];
  for (const row of rows) {
    if (row.conversation.pinned) pinned.push(row);
    else recent.push(row);
  }
  return { pinned, recent };
}

export type StudioCardStatus = "generating" | "complete" | "failed" | "stopped";

export type StudioCard = {
  /** Attempt id; unique per generation card. */
  id: string;
  conversationId: string;
  attemptId: string;
  prompt: string;
  modelId: string;
  createdAt: string;
  status: StudioCardStatus;
  mediaId: string | null;
  width: number | null;
  height: number | null;
  errorKind: string | null;
  error: string | null;
  attempt: DirectChatAttempt;
};

function cardStatusFor(attempt: DirectChatAttempt, hasMedia: boolean): StudioCardStatus {
  if (attempt.state === "pending" || attempt.state === "streaming") return "generating";
  if (attempt.state === "complete" && hasMedia) return "complete";
  if (attempt.state === "stopped" || attempt.state === "interrupted") return "stopped";
  return "failed";
}

/**
 * Project image conversations into Studio gallery cards, newest first.
 *
 * Every completed attempt that saved an image becomes a card so earlier
 * generations are never hidden by a later retry, while only the latest
 * non-complete attempt for a prompt is shown (so retrying a failed generation
 * replaces the failed card with the live generating card).
 */
export function studioCards(transcripts: readonly DirectChatTranscript[]): StudioCard[] {
  const cards: StudioCard[] = [];

  for (const transcript of transcripts) {
    if (transcript.conversation.archived) continue;
    const imageAttempts = transcript.attempts.filter((attempt) => isImageAttempt(attempt));
    if (imageAttempts.length === 0) continue;

    const messagesById = new Map(transcript.messages.map((msg) => [msg.id, msg]));
    const mediaById = new Map<string, DirectChatMedia>(
      (transcript.media ?? []).map((item) => [item.id, item]),
    );

    const latestByUserMessage = new Map<string, DirectChatAttempt>();
    for (const attempt of imageAttempts) {
      latestByUserMessage.set(attempt.userMessageId, attempt);
    }

    for (const attempt of imageAttempts) {
      const mediaId = attempt.mediaIds?.[0] ?? null;
      const mediaRecord = mediaId ? (mediaById.get(mediaId) ?? null) : null;
      const isCompleteWithMedia = attempt.state === "complete" && mediaId !== null;
      const isLatestForPrompt = latestByUserMessage.get(attempt.userMessageId)?.id === attempt.id;

      // Superseded failed or stopped attempts are omitted once a newer attempt
      // for the same prompt exists.
      if (!isCompleteWithMedia && !isLatestForPrompt) continue;

      const userMessage = messagesById.get(attempt.userMessageId);
      const prompt =
        attempt.imagePrompt?.trim() ||
        userMessage?.text.trim() ||
        transcript.conversation.title.trim();

      cards.push({
        id: attempt.id,
        conversationId: transcript.conversation.id,
        attemptId: attempt.id,
        prompt,
        modelId: attempt.modelId,
        createdAt: attempt.startedAt || transcript.conversation.updatedAt,
        status: cardStatusFor(attempt, mediaId !== null),
        mediaId,
        width: mediaRecord?.width ?? null,
        height: mediaRecord?.height ?? null,
        errorKind: attempt.errorKind,
        error: attempt.error,
        attempt,
      });
    }
  }

  return cards.sort((a, b) => {
    // Generating cards stay at the very top of their day so in-flight work is
    // immediately visible after tapping Generate.
    if ((a.status === "generating") !== (b.status === "generating")) {
      return a.status === "generating" ? -1 : 1;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export type StudioDayKey =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; isoDate: string; year: number; month: number; day: number };

export type StudioDayGroup = {
  key: string;
  day: StudioDayKey;
  cards: StudioCard[];
};

function calendarParts(date: Date): { year: number; month: number; day: number; key: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, key };
}

/**
 * Group Studio cards by UTC calendar day relative to `now`.
 *
 * Using UTC calendar dates keeps day bucketing deterministic across time zones
 * in unit tests while matching ISO timestamps stored on attempts.
 */
export function groupByDay(
  cards: readonly StudioCard[],
  now: Date = new Date(),
): StudioDayGroup[] {
  const todayParts = calendarParts(now);
  const yesterdayDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const yesterdayParts = calendarParts(yesterdayDate);

  const groups = new Map<string, StudioDayGroup>();

  for (const card of cards) {
    const parsed = new Date(card.createdAt);
    const valid = !Number.isNaN(parsed.getTime()) ? parsed : now;
    const parts = calendarParts(valid);

    let day: StudioDayKey;
    let groupKey: string;
    if (parts.key === todayParts.key) {
      day = { kind: "today" };
      groupKey = "today";
    } else if (parts.key === yesterdayParts.key) {
      day = { kind: "yesterday" };
      groupKey = "yesterday";
    } else {
      day = {
        kind: "date",
        isoDate: parts.key,
        year: parts.year,
        month: parts.month,
        day: parts.day,
      };
      groupKey = parts.key;
    }

    const existing = groups.get(groupKey);
    if (existing) {
      existing.cards.push(card);
    } else {
      groups.set(groupKey, { key: groupKey, day, cards: [card] });
    }
  }

  return [...groups.values()];
}
