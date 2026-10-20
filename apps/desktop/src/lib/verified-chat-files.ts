import type { FsChatRefEntryKind } from "@minih-agent/shared";
import type { ChatTextSegment } from "./chat-links";

const MAX_MESSAGE_CANDIDATES = 32;
const MAX_CONCURRENT_LOOKUPS = 4;
type FileSegment = Extract<ChatTextSegment, { kind: "target" }> & {
  target: { kind: "file"; path: string };
};

/** Explicit composer refs need no speculative lookup to retain their chip. */
function needsVerification(segment: ChatTextSegment): segment is FileSegment {
  return segment.kind === "target" && segment.target.kind === "file" &&
    !segment.text.startsWith("@");
}

/**
 * Keep the references the host confirmed and carry what answered: a chip's menu
 * needs to know whether a file or a folder was found, because the two do not
 * share an action.
 */
export function verifiedChatSegments(
  segments: ChatTextSegment[],
  verified: ReadonlySet<string>,
  entryKinds?: ReadonlyMap<string, FsChatRefEntryKind>,
): ChatTextSegment[] {
  return segments.map((segment) => {
    if (segment.kind !== "target" || segment.target.kind !== "file") return segment;
    if (needsVerification(segment) && !verified.has(segment.target.path)) {
      return { kind: "text", text: segment.text };
    }
    const entryKind = entryKinds?.get(segment.target.path);
    return entryKind
      ? { ...segment, target: { ...segment.target, entryKind } as typeof segment.target }
      : segment;
  });
}

/** Deduplicate and bound speculative work before starting any IPC. */
export function chatFileCandidates(
  segments: ChatTextSegment[],
  known: ReadonlySet<string> = new Set(),
): string[] {
  const paths = new Set<string>();
  for (const segment of segments) {
    if (needsVerification(segment) && !known.has(segment.target.path)) {
      paths.add(segment.target.path);
      if (paths.size === MAX_MESSAGE_CANDIDATES) break;
    }
  }
  return [...paths];
}

/** Unverified candidates remain readable text on failure or cancellation. */
export async function verifyChatFiles(
  paths: readonly string[],
  resolve: (path: string) => Promise<boolean>,
  signal: AbortSignal,
  onError: () => void,
): Promise<Set<string>> {
  const verified = new Set<string>();
  for (const path of paths) {
    if (signal.aborted) break;
    try {
      const exists = await resolve(path);
      if (signal.aborted) break;
      if (exists) verified.add(path);
    } catch {
      if (!signal.aborted) onError();
    }
  }
  return verified;
}

/**
 * Share a small IPC budget across visible message rows; abort queued work.
 *
 * Cancelled work settles with `cancelled` rather than a normal answer, so a
 * caller that resolves something richer than a boolean — an entry kind, say —
 * does not have to invent a value that looks like a real result.
 */
export function createChatFileVerificationQueue<T = boolean>(cancelled = false as T) {
  let active = 0;
  const pending: Array<() => void> = [];
  const drain = () => {
    while (active < MAX_CONCURRENT_LOOKUPS && pending.length) pending.shift()?.();
  };
  return (resolve: () => Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise((accept, reject) => {
      if (signal.aborted) { accept(cancelled); return; }
      const cancel = () => {
        const index = pending.indexOf(run);
        if (index >= 0) pending.splice(index, 1);
        accept(cancelled);
      };
      const run = () => {
        signal.removeEventListener("abort", cancel);
        active += 1;
        Promise.resolve().then(() => signal.aborted ? cancelled : resolve()).then(accept, reject).finally(() => {
          active -= 1;
          drain();
        });
      };
      signal.addEventListener("abort", cancel, { once: true });
      pending.push(run);
      drain();
    });
}
