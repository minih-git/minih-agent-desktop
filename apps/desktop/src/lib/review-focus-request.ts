import { useSyncExternalStore } from "react";
import type { UiMessage } from "@minih-agent/shared";

export type ReviewFocusRequest = {
  sessionId: string;
  snapshotIds: readonly string[];
  /** Selected durable rows may come from an earlier transcript reading window. */
  messages: readonly UiMessage[];
  expand: boolean;
  seq: number;
};
let current: ReviewFocusRequest | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

/** Transient navigation intent, not persisted review or session state. */
export function requestReviewFocus(
  snapshotIds: readonly string[],
  options: Pick<ReviewFocusRequest, "sessionId" | "messages" | "expand">,
): void {
  if (snapshotIds.length === 0) return;
  current = { ...options, messages: [...options.messages], snapshotIds: [...snapshotIds], seq: ++sequence };
  for (const listener of listeners) listener();
}
export function currentReviewFocusRequest(): ReviewFocusRequest | null { return current; }
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useReviewFocusRequest(): ReviewFocusRequest | null {
  return useSyncExternalStore(subscribe, currentReviewFocusRequest, () => null);
}
