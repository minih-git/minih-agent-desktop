import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PendingToolRequest,
  QueueStore,
  QueuedTurnRecord,
  SessionPort,
  SessionSummary,
} from "@minih-agent/agent-host";
import { RacpError } from "@minih-agent/agent-host";
import type { MessageAttachment, RacpItemSummary, RacpPermissionMode, UiMessage, VoiceOrigin } from "@minih-agent/shared";

import { encodeSessionMediaId, sessionAttachmentRowId } from "./session-media.js";

/** Rust host-core over stdio JSON-RPC, as the ports below need it. */
export type HostRpc = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type HostSessionRecord = {
  id: string;
  title?: string;
  projectId?: string;
  projectPath?: string;
  providerId?: string;
  modelId?: string;
  modelLabel?: string;
  thinkingLevel?: string;
  mode?: string;
  permissionMode?: string;
  planningState?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: UiMessage[];
  /** Window cursors host-core returns for a bounded read. */
  messageStart?: number;
  hasMoreBefore?: boolean;
};

/** Opaque Main/Host authorization fingerprint; never send the source identity to the renderer or model. */
export function sessionWorkspaceIdentity(input: { projectId?: unknown; projectPath?: unknown }): string | null {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const projectPath = typeof input.projectPath === "string" ? input.projectPath.trim() : "";
  if (!projectId && !projectPath) return null;
  return createHash("sha256").update(JSON.stringify([projectId, projectPath])).digest("hex");
}

export function requireHostRpc(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host is not running", { retriable: true });
  return host;
}

export function toSessionSummary(
  record: HostSessionRecord,
  defaults?: { permissionMode?: RacpPermissionMode },
): SessionSummary {
  const mode = record.mode === "plan" || record.mode === "goal" ? record.mode : "agent";
  const permissionMode: RacpPermissionMode =
    record.permissionMode === "accept-edits" || record.permissionMode === "auto" || record.permissionMode === "ask"
      ? record.permissionMode
      : record.permissionMode === "inherit" && defaults?.permissionMode
        ? defaults.permissionMode
        : "ask";
  const planningState =
    record.planningState === "planning" || record.planningState === "awaiting_approval"
      ? record.planningState
      : "inactive";
  const modelId = typeof record.modelId === "string" && record.modelId.trim() ? record.modelId.trim() : undefined;
  const providerId = typeof record.providerId === "string" && record.providerId.trim() ? record.providerId.trim() : undefined;
  const modelLabel =
    typeof record.modelLabel === "string" && record.modelLabel.trim()
      ? record.modelLabel.trim()
      : modelId;
  const thinkingLevel =
    typeof record.thinkingLevel === "string" && record.thinkingLevel.trim()
      ? record.thinkingLevel.trim()
      : undefined;
  return {
    id: record.id,
    title: record.title ?? "",
    ...(record.projectId ? { projectId: record.projectId } : {}),
    workspaceIdentity: sessionWorkspaceIdentity(record),
    ...(record.projectPath ? { workspaceLabel: basename(record.projectPath) } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    mode,
    permissionMode,
    planningState,
    createdAt: record.createdAt ?? new Date(0).toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
  };
}

const FILE_HTML_LINK_RE = /\[[^\]]*\]\((file:\/\/\/[^)\s]+?\.html?)\)/i;
const MAX_INLINE_HTML_BYTES = 200 * 1024;

function inlineLocalHtmlIfLinked(message: UiMessage): UiMessage {
  if (message.role !== "assistant" || typeof message.content !== "string") return message;
  if (/```html\b/i.test(message.content)) return message;
  const match = FILE_HTML_LINK_RE.exec(message.content);
  if (!match?.[1]) return message;
  try {
    const filePath = fileURLToPath(match[1]);
    if (!existsSync(filePath)) return message;
    const st = statSync(filePath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_INLINE_HTML_BYTES) return message;
    const rawHtml = readFileSync(filePath, "utf8")
      .replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "")
      .replace(/<textarea[^>]*id=["']am-source["'][^>]*>[\s\S]*?<\/textarea>/gi, "");
    const fence = "`````";
    return {
      ...message,
      content: `${message.content}\n\n${fence}html\n${rawHtml}\n${fence}`,
    };
  } catch {
    return message;
  }
}

/** Raster types `session/mediaRead` can serve, the same set `session-media` allows. */
const RACP_RASTER_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** `attachments/<sha256>`: the only ref shape the Host can read back as media. */
const RACP_MEDIA_REF = /^attachments\/[0-9a-f]{64}$/;

/**
 * Whether `session/mediaRead` could serve this attachment.
 *
 * This mirrors `session-media`'s own membership rule on purpose: an item names
 * a `mediaId` only where the reader would accept the row, so a client never
 * receives a preview reference that the Host then refuses. A non-raster
 * attachment (a workspace PDF, a session link, an SVG, a legacy absolute path)
 * keeps its plain `ref` and carries no `mediaId`.
 */
function isSessionMediaAttachment(attachment: MessageAttachment): boolean {
  if (attachment.kind !== "image") return false;
  const mimeType = String(attachment.mimeType ?? "").trim().toLowerCase();
  if (!RACP_RASTER_MIME.has(mimeType)) return false;
  return RACP_MEDIA_REF.test(String(attachment.ref ?? "").trim().replace(/\\/g, "/"));
}

/**
 * The transcript message as a remote client receives it.
 *
 * A raster attachment gains an opaque `mediaId` — `encodeSessionMediaId(message
 * id, row id)` — so a phone can reopen the image through `session/mediaRead`
 * long after it forgot the bytes (D6). The row id is `sessionAttachmentRowId`'s
 * answer: the attachment's own id when it has one, otherwise its position in the
 * message, because a message read back from a Host session record carries no
 * attachment ids. Every other field is passed through untouched.
 */
function withSessionMediaIds(message: UiMessage): UiMessage {
  const attachments = message.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0 || !message.id) return message;
  let projected = false;
  const annotated = attachments.map((attachment, index) => {
    // The row id comes from the shared helper, not from the attachment alone: a
    // message read back from a Host session record has no attachment ids at all,
    // and skipping those is why a user's own photo never reached the phone.
    if (!isSessionMediaAttachment(attachment)) return attachment;
    projected = true;
    return {
      ...attachment,
      mediaId: encodeSessionMediaId(message.id, sessionAttachmentRowId(attachment, index)),
    };
  });
  return projected ? { ...message, attachments: annotated } : message;
}

export function toRacpItem(message: UiMessage): RacpItemSummary {
  const turnId = (message as { turnId?: string }).turnId ?? "";
  const enriched = withSessionMediaIds(inlineLocalHtmlIfLinked(message));
  return {
    id: enriched.id,
    turnId,
    itemType: "message",
    status: enriched.status === "streaming" ? "streaming" : "completed",
    createdAt: enriched.createdAt,
    ...(enriched.parentToolCallId ? { parentToolCallId: enriched.parentToolCallId } : {}),
    ...(enriched.nestedParentToolCallId ? { nestedParentToolCallId: enriched.nestedParentToolCallId } : {}),
    ...(enriched.agentName ? { agentName: enriched.agentName } : {}),
    content: enriched,
  };
}

/**
 * How much of one message field a phone needs. The desktop renderer reads its
 * transcript with the same cap; the remote path had none, so one tool result
 * crossed the network whole. host-core marks what it clipped in the text
 * itself (`truncate_display_text`), which is the truncation notice both
 * clients already render.
 */
const REMOTE_CONTENT_LIMIT = 64 * 1024;

/** Session metadata and transcript pages straight from host `session.get`. */
export function createHostSessionPort(getHost: () => HostRpc | null): SessionPort {
  async function fetchSession(
    sessionId: string,
    window: { messageLimit: number; messageBeforeId?: string },
  ): Promise<HostSessionRecord | null> {
    const host = getHost();
    if (!host) return null;
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", {
      id: sessionId,
      messageLimit: window.messageLimit,
      ...(window.messageBeforeId ? { messageBeforeId: window.messageBeforeId } : {}),
      contentLimit: REMOTE_CONTENT_LIMIT,
    });
    return result.session ?? null;
  }
  return {
    async get(sessionId) {
      // Metadata only. The uncapped read parsed the whole transcript — a real
      // 12 MB, 572-message session — to answer a question the index row already
      // holds, on every attach and every turn admission.
      const record = await fetchSession(sessionId, { messageLimit: 1 });
      if (!record) return null;
      let defaultPermissionMode: RacpPermissionMode | undefined;
      if (record.permissionMode === "inherit") {
        const host = getHost();
        const settings = await host
          ?.call<{ defaultPermissionMode?: string }>("settings.get", {})
          .catch(() => null);
        const pm = settings?.defaultPermissionMode;
        if (pm === "ask" || pm === "accept-edits" || pm === "auto") {
          defaultPermissionMode = pm;
        }
      }
      return toSessionSummary(record, defaultPermissionMode ? { permissionMode: defaultPermissionMode } : undefined);
    },
    async history(sessionId, { limit, beforeItemId }) {
      // One bounded window instead of the whole transcript, walked from the
      // message id the client holds: host-core resolves it against the file
      // itself, so the window agrees with the transcript even when the index
      // lags. A window whose id is gone comes back empty and ends the walk.
      const record = await fetchSession(sessionId, {
        messageLimit: limit,
        ...(beforeItemId ? { messageBeforeId: beforeItemId } : {}),
      });
      return {
        items: (record?.messages ?? []).map(toRacpItem),
        hasMore: record?.hasMoreBefore === true,
      };
    },
  };
}

export type HostQueueEntry = {
  id: string;
  sessionId: string;
  principal: string;
  idempotencyKey?: string;
  inputHash: string;
  content: string;
  sessionMessageId?: string;
  userMessageId?: string;
  voiceOrigin?: VoiceOrigin;
  attachments?: unknown;
  permissionMode: string;
  position: number;
  priority?: number;
  createdAt: string;
};

export function fromHostQueueEntry(entry: HostQueueEntry): QueuedTurnRecord {
  const permissionMode: RacpPermissionMode =
    entry.permissionMode === "accept-edits" || entry.permissionMode === "auto" ? entry.permissionMode : "ask";
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    principalSubject: entry.principal,
    content: entry.content,
    ...(entry.sessionMessageId ? { sessionMessageId: entry.sessionMessageId } : {}),
    ...(entry.userMessageId ? { userMessageId: entry.userMessageId } : {}),
    ...(entry.voiceOrigin ? { voiceOrigin: entry.voiceOrigin } : {}),
    ...(Array.isArray(entry.attachments) ? { attachments: entry.attachments as QueuedTurnRecord["attachments"] } : {}),
    effectivePermissionMode: permissionMode,
    ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
    inputHash: entry.inputHash,
    ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
    createdAt: Date.parse(entry.createdAt) || 0,
  };
}

/** The Host-owned turn queue persisted by host-core (schema v15, ADR 0213). */
export function createHostQueueStore(getHost: () => HostRpc | null): QueueStore {
  return {
    async listAll() {
      const host = getHost();
      if (!host) return [];
      const result = await host.call<{ entries?: HostQueueEntry[] }>("session.queueList", {});
      return (result.entries ?? []).map(fromHostQueueEntry);
    },
    async push(record) {
      await requireHostRpc(getHost).call("session.queuePush", {
        id: record.id,
        sessionId: record.sessionId,
        principal: record.principalSubject,
        ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
        inputHash: record.inputHash,
        content: record.content,
        ...(record.sessionMessageId ? { sessionMessageId: record.sessionMessageId } : {}),
        ...(record.userMessageId ? { userMessageId: record.userMessageId } : {}),
        ...(record.voiceOrigin ? { voiceOrigin: record.voiceOrigin } : {}),
        ...(record.attachments ? { attachments: record.attachments } : {}),
        permissionMode: record.effectivePermissionMode,
      });
    },
    async remove(id) {
      const result = await requireHostRpc(getHost).call<{ removed?: boolean }>("session.queueRemove", { id });
      return result.removed === true;
    },
    async prioritize(id) {
      await requireHostRpc(getHost).call("session.queuePrioritize", { id });
    },
    async reorder(id, direction) {
      const result = await requireHostRpc(getHost).call<{ moved?: boolean }>("session.queueReorder", {
        id,
        direction,
      });
      return result.moved === true;
    },
  };
}

/** Open tool requests as Host state (`permissions.pending`). */
export async function listPendingToolRequests(
  getHost: () => HostRpc | null,
  sessionId?: string,
): Promise<PendingToolRequest[]> {
  const host = getHost();
  if (!host) return [];
  const result = await host.call<{ requests?: PendingToolRequest[] }>("permissions.pending", {
    ...(sessionId ? { sessionId } : {}),
  });
  return result.requests ?? [];
}
