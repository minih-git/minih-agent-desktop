import type { FsChatRefEntryKind } from "@minih-agent/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  resolvePreviewTarget,
  safeDecodeUri,
  UNVERIFIED_CHAT_REF_ATTRIBUTE,
  type ChatPreviewTarget,
} from "../lib/chat-links";
import { createChatFileVerificationQueue } from "../lib/verified-chat-files";
import { useSlotSessionId } from "../plugins/renderer-slots/use-slots";
import { useAppStore } from "../stores/app-store";
import { useChatSessionCapability } from "./use-chat-session-capability";

/**
 * Existence checks for the references that only become links once the disk
 * agrees they exist: a folder, or a path with no extension.
 *
 * Prose cannot tell `apps/desktop/src` from a sentence about one, and a reply
 * routinely writes `/api/v1/users` as a route rather than a file. Those shapes
 * are therefore recognized as candidates and confirmed here before the
 * transcript turns them into something clickable, which is the same bar a user
 * message already met through `use-verified-chat-text`.
 *
 * Two rules shape the cache:
 *
 *   - a confirmation belongs to one workspace and one session, because the
 *     session decides which scratch store answers;
 *   - only "it exists" is cached. A reply often names a path it is about to
 *     create (`这里会生成 out/`), so a miss must not outlive the component that
 *     asked: a re-mount asks again and the path becomes a link once it is there.
 *
 * A session without local tools asks nothing at all: probing whether a path
 * exists is itself a local operation, and `useResolveChatFileRef` already
 * refuses to open one.
 */

export type ChatRefExistence =
  /**
   * Confirmed. `entryKind` says whether a file or a folder answered, and
   * `outsideProject` means the entry lives beyond every root the app reads:
   * the reference becomes a link, but only to show it and copy its path.
   */
  | { state: "exists"; entryKind: FsChatRefEntryKind; outsideProject?: true }
  /** The host reports nothing at that path. */
  | { state: "absent" }
  /** Not confirmed yet; the caller shows the reference as plain text. */
  | { state: "pending" };

const PENDING: ChatRefExistence = { state: "pending" };
const scheduleLookup = createChatFileVerificationQueue<ChatRefExistence>(PENDING);

/** Bounded, because a long conversation can mention many paths. */
const MAX_CACHED_REFS = 512;
/** Confirmations only: a miss is never remembered across a component. */
const confirmed = new Map<string, ChatRefExistence & { state: "exists" }>();
const inFlight = new Map<string, Promise<ChatRefExistence>>();

function cacheKey(
  workspacePath: string | null,
  sessionId: string | null,
  path: string,
): string {
  return `${workspacePath ?? ""}\u0000${sessionId ?? ""}\u0000${path}`;
}

/** Cache key for `peekChatRefExistence` and `confirmChatRefExists`. */
export function chatRefExistenceKey(
  workspacePath: string | null | undefined,
  sessionId: string | null | undefined,
  path: string,
): string {
  return cacheKey(workspacePath ?? null, sessionId ?? null, path);
}

function remember(key: string, value: ChatRefExistence & { state: "exists" }): ChatRefExistence {
  confirmed.delete(key);
  confirmed.set(key, value);
  while (confirmed.size > MAX_CACHED_REFS) {
    const oldest = confirmed.keys().next().value;
    if (oldest === undefined) break;
    confirmed.delete(oldest);
  }
  return value;
}

/**
 * What the host last said about `path`, without asking again.
 *
 * A menu is built synchronously from the click, so it reads this instead of
 * awaiting a round trip that would delay the surface past the pointer. Only a
 * confirmation is ever here; "nothing there" is not a durable fact.
 */
export function peekChatRefExistence(
  path: string,
  workspacePath: string | null | undefined,
  sessionId: string | null | undefined,
): ChatRefExistence | null {
  return confirmed.get(cacheKey(workspacePath ?? null, sessionId ?? null, path)) ?? null;
}

/**
 * Confirm one reference, sharing work with every other caller asking about the
 * same path in the same workspace and session.
 */
export async function confirmChatRefExists(
  path: string,
  sessionId: string | undefined,
  key: string,
  signal: AbortSignal,
): Promise<ChatRefExistence> {
  const known = confirmed.get(key);
  if (known) return known;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = scheduleLookup(async () => {
    try {
      const result = await api.fsResolveRef(path, sessionId);
      const match = result.match;
      if (match) {
        return remember(key, { state: "exists", entryKind: match.entryKind ?? "file" });
      }
      // A reference the app may not read can still be located. The host stats
      // it and reports only whether it is a file or a folder, so the link shows
      // its reveal-and-copy menu instead of a "restricted" message.
      const outside = result.outside;
      if (outside) {
        return remember(key, {
          state: "exists",
          entryKind: outside.entryKind,
          outsideProject: true,
        });
      }
      return { state: "absent" } as ChatRefExistence;
    } catch {
      // A failed lookup is not evidence either way, so it is neither cached nor
      // reported as a miss; the reference keeps rendering as plain text.
      return PENDING;
    }
  }, signal).finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

/**
 * Confirm one reference inside the rendered conversation.
 *
 * `target` is a file target from `resolvePreviewTarget`. A target that carries
 * no `unverified` marker is already what the author wrote, so it is reported as
 * existing without a lookup: known extensions and explicit `@` mentions keep
 * their behavior and cost nothing.
 *
 * Passing `null` is how a caller refuses to ask at all — a session without
 * local tools, which must not probe the filesystem.
 */
export function useChatRefExists(target: ChatPreviewTarget | null): ChatRefExistence {
  // The pane's session, not the window's: a split pane can show another
  // conversation, and its scratch store is the one that answers for it.
  const paneSessionId = useSlotSessionId();
  const workspacePath = useAppStore((state) => state.workspace?.path ?? null);
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId || null);
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const unverified = target?.kind === "file" && target.unverified === true;
  const path = unverified && localToolsAllowed ? target.path : null;
  const key = path ? cacheKey(workspacePath, sessionId, path) : "";
  const [asked, setAsked] = useState<{ key: string; value: ChatRefExistence } | null>(null);

  useEffect(() => {
    if (!path || !key) return;
    const known = confirmed.get(key);
    if (known) {
      setAsked({ key, value: known });
      return;
    }
    const controller = new AbortController();
    void confirmChatRefExists(path, sessionId ?? undefined, key, controller.signal).then((value) => {
      if (!controller.signal.aborted) setAsked({ key, value });
    });
    return () => controller.abort();
  }, [key, path, sessionId]);

  if (!path) {
    // A reference that needs no confirmation, and one this session may not
    // check, both read as "nothing to wait for"; the caller's own permission
    // gate decides what it renders.
    return target?.kind === "file" && target.unverified === true
      ? PENDING
      : { state: "exists", entryKind: "file" };
  }
  if (asked?.key === key && asked.value.state !== "pending") return asked.value;
  return confirmed.get(key) ?? PENDING;
}

/**
 * The linker's "still unconfirmed" marker on an anchor, if it carries one.
 *
 * The marker is markup, not content: `linkifyMdastTree` writes it and
 * sanitization keeps it, and `withoutChatRefMarker` strips it before render so
 * it never reaches the DOM.
 */
export function unverifiedChatRefMarker(props: Record<string, unknown>): string | null {
  const value = props[UNVERIFIED_CHAT_REF_ATTRIBUTE];
  return typeof value === "string" ? value : null;
}

/** `props` with the marker removed, leaving a clean element to render. */
export function withoutChatRefMarker<T extends Record<string, unknown>>(props: T): T {
  if (!Object.hasOwn(props, UNVERIFIED_CHAT_REF_ATTRIBUTE)) return props;
  const { [UNVERIFIED_CHAT_REF_ATTRIBUTE]: _marker, ...clean } = props;
  return clean as T;
}

/**
 * What an anchor that names a path still needs before it can act as a link.
 *
 * `unconfirmed` stays true until the host confirms the entry, which is the only
 * point at which a destination may be rendered at all. A session without local
 * tools confirms nothing, because asking is itself a local operation.
 */
export function useChatRefLinkState(
  marked: boolean,
  href: string | undefined,
  root: string | null | undefined,
  baseDir: string,
): {
  unconfirmed: boolean;
  entryKind: FsChatRefEntryKind | undefined;
  outsideProject: boolean;
} {
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const candidate = useMemo(
    () => (marked && href ? resolvePreviewTarget(safeDecodeUri(href), root, baseDir) : null),
    [baseDir, href, marked, root],
  );
  const existence = useChatRefExists(
    localToolsAllowed && candidate?.kind === "file" ? candidate : null,
  );
  return {
    outsideProject: existence.state === "exists" && existence.outsideProject === true,
    // Without local tools nothing can be confirmed, so a marked link stays the
    // text it names; the same is true until a lookup says the entry is there.
    unconfirmed: marked && (
      !localToolsAllowed || candidate?.kind !== "file" || existence.state !== "exists"
    ),
    entryKind: localToolsAllowed && existence.state === "exists" ? existence.entryKind : undefined,
  };
}

/**
 * The target a code span may act on, and what confirmed it.
 *
 * A code span naming a folder or an extensionless path is only clickable once
 * the host has confirmed the entry, so this returns `null` until then — and
 * `null` immediately for a session that may not ask, because probing whether a
 * path exists is itself a local operation.
 */
export function useConfirmedChatRefTarget(
  target: ChatPreviewTarget | null,
  allowed: boolean,
): {
  target: ChatPreviewTarget | null;
  entryKind: FsChatRefEntryKind | undefined;
  outsideProject: boolean;
} {
  const existence = useChatRefExists(
    allowed && target?.kind === "file" ? target : null,
  );
  const unconfirmed = target?.kind === "file" && target.unverified === true &&
    existence.state !== "exists";
  return {
    target: unconfirmed ? null : target,
    entryKind: existence.state === "exists" ? existence.entryKind : undefined,
    outsideProject: existence.state === "exists" && existence.outsideProject === true,
  };
}
