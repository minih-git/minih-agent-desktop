import { IPC, type BotsChangedEvent, type TaskCardsChangedEvent } from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/**
 * The employee surface (ADR bot-sessions-and-steward §5).
 *
 * Two rules are why this is its own module rather than more `session.*` calls:
 *
 * - **Confirming a card is a person's click.** `taskCardConfirm` is reachable
 *   only from the renderer, and the model has no tool that reaches it, no
 *   `confirm` action on `TaskCard` and no `mandate` argument on `SessionSend`.
 *   This module is the only place in the product that confirms.
 * - **Seeding is explicit.** `botSeedDefaults` runs when the user asks for it
 *   and never at startup, so no install silently grows four sessions.
 */
export function registerBotIpc({
  registrar,
  getHost,
  sendToRenderer,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
}): void {
  const { handle } = registrar;
  const host = (): HostProcess => {
    const current = getHost();
    if (!current?.isAvailable()) throw new Error("host unavailable");
    return current;
  };

  handle(IPC.invoke.botList, async () => host().call("bot.list", {}));

  handle(IPC.invoke.botCreate, async (request) => {
    const result = await host().call("bot.create", (request ?? {}) as Record<string, unknown>);
    const event: BotsChangedEvent = { reason: "created" };
    sendToRenderer(IPC.event.botsChanged, event);
    return result;
  });

  handle(IPC.invoke.botUpdate, async (request) => {
    const result = await host().call("bot.update", (request ?? {}) as Record<string, unknown>);
    sendToRenderer(IPC.event.botsChanged, { reason: "updated" } satisfies BotsChangedEvent);
    return result;
  });

  handle(IPC.invoke.botDismiss, async (request) => {
    const result = await host().call("bot.dismiss", (request ?? {}) as Record<string, unknown>);
    sendToRenderer(IPC.event.botsChanged, { reason: "dismissed" } satisfies BotsChangedEvent);
    return result;
  });

  handle(IPC.invoke.botSeedDefaults, async () => {
    const result = await host().call("bot.seedDefaults", {});
    sendToRenderer(IPC.event.botsChanged, { reason: "seeded" } satisfies BotsChangedEvent);
    return result;
  });

  handle(IPC.invoke.taskCardList, async (request) => {
    const { sessionId } = (request ?? {}) as { sessionId?: string };
    if (!sessionId) throw new Error("sessionId is required");
    return host().call("taskCard.list", { sessionId });
  });

  // The click. `cardHash` is the hash of the card the person was looking at, so
  // a revise between render and click is refused by the host instead of
  // approving text nobody read.
  handle(IPC.invoke.taskCardConfirm, async (request) => {
    const { draftId, cardHash, notifyOnCompletion } = (request ?? {}) as {
      draftId?: string;
      cardHash?: string;
      notifyOnCompletion?: boolean;
    };
    if (!draftId || !cardHash) throw new Error("draftId and cardHash are required");
    const result = (await host().call("taskCard.confirm", {
      draftId,
      cardHash,
      confirmedBy: "user",
      ...(typeof notifyOnCompletion === "boolean" ? { notifyOnCompletion } : {}),
      // The host scopes this key to (plugin, source session), so the draft id is
      // the natural identity: a retried click cannot dispatch the work twice.
      idempotencyKey: `taskcard-confirm:${draftId}`,
      policyVersion: "steward-1",
    })) as { draft?: { sessionId?: string; id?: string }; delivery?: { id?: string } };
    const event: TaskCardsChangedEvent = {
      sessionId: result.draft?.sessionId ?? "",
      draftId,
    };
    sendToRenderer(IPC.event.taskCardsChanged, event);
    sendToRenderer(IPC.event.botsChanged, { reason: "status" } satisfies BotsChangedEvent);
    return { draft: result.draft, deliveryId: result.delivery?.id };
  });

  handle(IPC.invoke.taskCardDrop, async (request) => {
    const { draftId } = (request ?? {}) as { draftId?: string };
    if (!draftId) throw new Error("draftId is required");
    const result = (await host().call("taskCard.drop", { draftId })) as {
      draft?: { sessionId?: string };
    };
    sendToRenderer(IPC.event.taskCardsChanged, {
      sessionId: result.draft?.sessionId ?? "",
      draftId,
    } satisfies TaskCardsChangedEvent);
    return result;
  });
}
