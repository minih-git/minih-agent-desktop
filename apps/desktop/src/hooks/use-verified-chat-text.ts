import type { MessageAttachment } from "@minih-agent/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { splitChatText } from "../lib/chat-links";
import {
  chatFileCandidates,
  createChatFileVerificationQueue,
  verifiedChatSegments,
  verifyChatFiles,
  type ChatRefEntryConfirmation,
} from "../lib/verified-chat-files";
import { useAppStore } from "../stores/app-store";

const scheduleVerification = createChatFileVerificationQueue();
const EMPTY: ReadonlySet<string> = new Set();

/** Confirmation belongs to this text and workspace path/session, never the next one. */
export function useVerifiedChatText(text: string, attachments?: readonly MessageAttachment[]) {
  const workspacePath = useAppStore((s) => s.workspace?.path);
  const sessionId = useAppStore((s) => s.activeSessionId);
  const request = useMemo(() => {
    const segments = splitChatText(text, workspacePath);
    const trusted = new Set(attachments?.map((attachment) => attachment.ref));
    return { segments, trusted, sessionId, paths: chatFileCandidates(segments, trusted) };
  }, [text, workspacePath, sessionId, attachments]);
  const [result, setResult] = useState<{
    request: typeof request;
    verified: ReadonlySet<string>;
    entryKinds: ReadonlyMap<string, ChatRefEntryConfirmation>;
  } | null>(null);
  useEffect(() => {
    if (request.paths.length === 0) return;
    const controller = new AbortController();
    const entryKinds = new Map<string, ChatRefEntryConfirmation>();
    void verifyChatFiles(
      request.paths,
      // A folder answers the lookup as readily as a file, and the chip has to
      // know which one it is: a folder is revealed, never opened.
      (path) => scheduleVerification(
        async () => {
          const result = await api.fsResolveRef(path, request.sessionId ?? undefined);
          const match = result.match;
          if (match) {
            entryKinds.set(path, { entryKind: match.entryKind ?? "file" });
            return true;
          }
          // An entry outside every root is still a reference the chip can act
          // on: show it, and copy its path.
          if (result.outside) {
            entryKinds.set(path, {
              entryKind: result.outside.entryKind,
              outsideProject: true,
            });
            return true;
          }
          return false;
        },
        controller.signal,
      ),
      controller.signal,
      // Avoid logging the message, path, or an arbitrary IPC error payload.
      () => console.warn("Chat file reference verification failed"),
    ).then((verified) => {
      if (!controller.signal.aborted) setResult({ request, verified, entryKinds });
    });
    return () => controller.abort();
  }, [request]);
  const verified = new Set([...request.trusted, ...(result?.request === request ? result.verified : EMPTY)]);
  return verifiedChatSegments(
    request.segments,
    verified,
    result?.request === request ? result.entryKinds : undefined,
  );
}
