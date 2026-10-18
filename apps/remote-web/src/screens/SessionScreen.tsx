/**
 * Session timeline (PR-4).
 *
 * The screen renders plain text rows, the pending approval and input cards, the
 * turn status with Stop/Interrupt for the active turn, and the composer. Every
 * in-flight control is disabled, and every failure names the operation it came
 * from plus the reason the Host or the transport gave.
 */
import { useTranslation } from "react-i18next";

import { ApprovalCard } from "../components/ApprovalCard.js";
import { AppShell, Button, Card, FailureBanner, Pill } from "../components/Chrome.js";
import { Composer } from "../components/Composer.js";
import { InputCard } from "../components/InputCard.js";
import { TimelineView } from "../components/Timeline.js";
import { useSessionScreen } from "../hooks/useSessionScreen.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { StreamState } from "../lib/stream-supervisor.js";
import { gatewayOrigin } from "../lib/runtime.js";

const STREAM_KEYS: Record<StreamState, string> = {
  idle: "session.connecting",
  open: "session.live",
  paused: "session.paused",
  retrying: "session.retrying",
  revoked: "session.revoked",
  exhausted: "session.exhausted",
  stopped: "session.stopped",
};

function streamTone(state: StreamState): "ok" | "warn" | "bad" | "neutral" {
  if (state === "open") return "ok";
  if (state === "paused" || state === "retrying") return "warn";
  if (state === "revoked" || state === "exhausted") return "bad";
  return "neutral";
}

export function SessionScreen({
  hostId,
  sessionId,
  title,
  credential,
  onBack,
}: {
  hostId: string;
  sessionId: string;
  title: string;
  credential: HostCredential;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { timeline, streamState, failure, pending, turnId, actions } = useSessionScreen({
    hostId,
    sessionId,
    credential,
    gatewayOrigin,
  });

  const turnStatus = timeline.activeTurnStatus;
  const active = turnId !== undefined;

  return (
    <AppShell
      title={timeline.session?.title || title || sessionId}
      onBack={onBack}
      actions={<Pill tone={streamTone(streamState)}>{t(STREAM_KEYS[streamState])}</Pill>}
      footer={
        <Composer
          sending={pending["turn/start"] === true}
          disabled={timeline.archived}
          queued={active}
          onSend={actions.sendTurn}
        />
      }
    >
      {failure ? (
        <FailureBanner failure={failure.failure} operationKey={failure.operationKey} onDismiss={actions.dismissFailure} />
      ) : null}

      {timeline.replayIncomplete ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          {t("session.replayIncomplete")}
        </p>
      ) : null}
      {timeline.needsResync ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          {t("session.resync")}
        </p>
      ) : null}
      {timeline.archived ? <p className="text-xs text-slate-500 dark:text-slate-400">{t("session.archived")}</p> : null}

      {streamState === "exhausted" ? (
        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            disabled={pending["stream/reconnect"] === true}
            aria-label={t("session.reconnect")}
            onClick={() => actions.reconnect()}
          >
            {t("session.reconnect")}
          </Button>
        </div>
      ) : null}

      {turnStatus ? (
        <Card className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t(`session.turn.${turnStatus}`)}</span>
          {timeline.queuedTurnIds.length > 0 ? (
            <Pill tone="neutral">{t("session.queuedCount", { count: timeline.queuedTurnIds.length })}</Pill>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="secondary"
            disabled={!active || pending["turn/stop"] === true}
            onClick={() => void actions.stop()}
          >
            {pending["turn/stop"] ? t("session.stopping") : t("session.stop")}
          </Button>
          <Button
            variant="warning"
            disabled={!active || pending["turn/interrupt"] === true}
            onClick={() => void actions.interrupt()}
          >
            {pending["turn/interrupt"] ? t("session.interrupting") : t("session.interrupt")}
          </Button>
        </Card>
      ) : null}

      {timeline.lastFailure?.message ? (
        <p className="text-xs text-red-700 dark:text-red-300">
          {t("session.turn.failed", { reason: timeline.lastFailure.message })}
        </p>
      ) : null}

      <TimelineView items={timeline.items} />

      {timeline.pendingApprovals.map((request) => (
        <ApprovalCard
          key={request.id}
          request={request}
          pending={pending[`approval:${request.id}`] === true}
          onDecide={(decision, attempt) =>
            void actions.respondApproval({ approvalId: request.id, decision, attempt })
          }
        />
      ))}

      {timeline.pendingInputs.map((request) => (
        <InputCard
          key={request.id}
          request={request}
          pending={pending[`input:${request.id}`] === true}
          onSubmit={(answers, attempt) => void actions.respondInput({ inputId: request.id, answers, attempt })}
        />
      ))}
    </AppShell>
  );
}
