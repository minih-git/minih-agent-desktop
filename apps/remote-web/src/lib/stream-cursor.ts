/**
 * The cursor the next stream subscription starts at (rollout D).
 *
 * A snapshot is valid only together with its `cursor` (protocol §5.4), so the
 * first subscription has to open *at* it: subscribing from "now" loses whatever
 * happened between the two calls. It is handed out exactly once, because every
 * later open is a different question — a reconnect after a drop resumes from the
 * last event the stream delivered, which the stream itself remembers. Passing
 * the snapshot's cursor again would replay the whole page from the snapshot on
 * every drop, which on a long conversation can fall outside the Host's replay
 * window and cost a full re-attach.
 */
import type { RacpCursor } from "@minih-agent/shared";

export type StartCursor = {
  /** Arm the next open with this cursor (a fresh snapshot's own cursor). */
  set(cursor: RacpCursor | null): void;
  /** Consume it: the value is returned once and then forgotten. */
  take(): RacpCursor | undefined;
};

export function createStartCursor(): StartCursor {
  let pending: RacpCursor | null = null;
  return {
    set(cursor) {
      pending = cursor;
    },
    take() {
      const value = pending ?? undefined;
      pending = null;
      return value;
    },
  };
}
