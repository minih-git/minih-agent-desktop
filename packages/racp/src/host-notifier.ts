/**
 * The Host's link-bound notifier (protocol §11.6, R5 PR-6, ADR 0331 decision 7).
 *
 * A Host that wants its user's phone to buzz has one job here: turn the four
 * notification-worthy events its runtime already produces into `host.notify`
 * frames while a link is up. Everything else — which devices may hear it, what
 * the push says, whether it is even enabled — belongs to the Gateway, because a
 * Host must never decide who is told about its own events.
 *
 * The frame carries ids and a fixed kind, so this class never sees content: the
 * event it is handed has a kind, a session id, and at most an approval id. That
 * is the whole reason the shape is defined this narrowly rather than passing an
 * event envelope with a redaction step.
 */
import { randomUUID } from "node:crypto";

import { RACP_NOTIFY_KINDS, type RacpHostNotify, type RacpNotifyKind } from "@minih-agent/shared";

import type { HostLinkLog, HostNotifier } from "./hostlink.js";

/** What a Host's runtime reports; ids and a kind, nothing else. */
export type NotifyEvent = {
  kind: RacpNotifyKind;
  sessionId: string;
  approvalId?: string;
  /**
   * Decisions the session still holds for the user, counted by the Host. It is
   * forwarded to the Gateway so the push can carry it as the app badge
   * (§17.6.2); a Host that does not count simply omits it.
   */
  attentionCount?: number;
  occurredAt?: string;
};

export type HostLinkNotifierOptions = {
  /** Bounded log; a notification failure must never affect a turn. */
  log?: HostLinkLog;
  now?: () => number;
  /** Test seam for the notification id. */
  newId?: () => string;
};

/**
 * Holds the sender of the current link. `attach` is called by the link core as
 * the link comes up and `detach` as it ends, so a notification is never written
 * to a socket that is gone.
 *
 * A notification is *not* queued while the link is down. It describes something
 * the user could act on now; delivering it after a reconnect would be a buzz
 * about an approval that was already answered or a turn that finished minutes
 * ago. The durable event stream remains the source of truth for what happened.
 */
export class HostLinkNotifier implements HostNotifier {
  private send: ((notify: RacpHostNotify) => void) | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: HostLinkNotifierOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => `ntf_${randomUUID()}`);
  }

  attach(send: (notify: RacpHostNotify) => void): void {
    this.send = send;
  }

  detach(): void {
    this.send = null;
  }

  /** Whether a link is up: false means a notification would go nowhere. */
  get attached(): boolean {
    return this.send !== null;
  }

  /**
   * Report one event. Returns whether a frame actually went out, so a caller
   * that wants to count what it told the Gateway is not guessing.
   */
  notify(event: NotifyEvent): boolean {
    const send = this.send;
    if (!send) return false;
    // The schema's own kind list is the guard: an event kind that is not one of
    // the four is a programming error here, and dropping it is safer than
    // teaching the Gateway a new field.
    if (!(RACP_NOTIFY_KINDS as readonly string[]).includes(event.kind)) {
      this.options.log?.("warn", "host notifier ignored an unknown notification kind", { kind: String(event.kind) });
      return false;
    }
    try {
      send({
        notifyId: this.newId(),
        kind: event.kind,
        sessionId: event.sessionId,
        ...(event.approvalId ? { approvalId: event.approvalId } : {}),
        ...(event.attentionCount === undefined ? {} : { attentionCount: event.attentionCount }),
        occurredAt: event.occurredAt ?? new Date(this.now()).toISOString(),
      });
      return true;
    } catch (error) {
      this.options.log?.("warn", "host notifier could not send", { error: String(error) });
      return false;
    }
  }
}
