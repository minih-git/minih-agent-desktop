/**
 * Session timeline (PR-4; scroll behaviour in rollout D).
 *
 * The screen renders the rows, the pending approval and input cards, the turn
 * status with Stop/Interrupt for the active turn, and the composer. Every
 * in-flight control is disabled, and every failure names the operation it came
 * from plus the reason the Host or the transport gave.
 *
 * The transcript is the scrolling part: it opens at the newest row, follows new
 * ones while the reader is at the bottom, offers a way back down (with a count)
 * when they are not, and holds their place when older rows are loaded above.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { FailureBanner } from "../components/Chrome.js";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatTimeline } from "../components/chat/ChatTimeline.js";
import { DecisionArea } from "../components/chat/DecisionArea.js";
import { RunBar } from "../components/chat/RunBar.js";
import { StopSheet } from "../components/chat/StopSheet.js";
import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { ResultState } from "../components/ui/EmptyState.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { useSessionScreen } from "../hooks/useSessionScreen.js";
import { useTimelineScroll } from "../hooks/useTimelineScroll.js";
import type { HostCredential } from "../lib/credential-port.js";
import { gatewayOrigin } from "../lib/runtime.js";
import {
  resolveConnectionBanner,
  resolveTurnStatusDisplay,
} from "../lib/session-format.js";

export interface SessionScreenProps {
  hostId: string;
  sessionId: string;
  title: string;
  credential: HostCredential;
  hostLabel?: string;
  onBack: () => void;
  onForget?: () => void;
}

export function SessionScreen({
  hostId,
  sessionId,
  title,
  credential,
  hostLabel,
  onBack,
  onForget,
}: SessionScreenProps) {
  const { t } = useTranslation();
  const [stopSheetOpen, setStopSheetOpen] = useState(false);

  const { timeline, streamState, failure, pending, loadingEarlier, turnId, actions } =
    useSessionScreen({
      hostId,
      sessionId,
      credential,
      gatewayOrigin,
    });

  const active = turnId !== undefined;
  const attention = timeline.pendingApprovals.length + timeline.pendingInputs.length;
  const tail = timeline.items.at(-1);
  const scroll = useTimelineScroll({
    itemCount: timeline.items.length,
    firstItemId: timeline.items[0]?.id ?? "",
    lastItemId: tail?.id ?? "",
    // A streamed row grows in place rather than adding a row, so its length is
    // part of what "new content" means.
    tailKey: tail ? `${tail.id}:${tail.text.length}:${tail.thinking?.length ?? 0}` : "",
    attention,
  });

  const hostName = hostLabel || hostId;
  const sessionTitle = timeline.session?.title || title || t("session.untitled", "未命名会话");

  // If revoked, show the full revoked ResultState (per spec 8.7)
  if (streamState === "revoked") {
    return (
      <Screen>
        <NavBar title={sessionTitle} onBack={onBack} />
        <div className="flex flex-1 items-center justify-center p-6">
          <ResultState
            status="error"
            title={t("hosts.status.revoked")}
            description={t("hosts.revokeHint")}
            action={
              onForget ? (
                <Button variant="primary" size="large" onClick={onForget}>
                  {t("hosts.expand.forgetAndPair")}
                </Button>
              ) : undefined
            }
          />
        </div>
      </Screen>
    );
  }

  const connBanner = resolveConnectionBanner(streamState);
  const decisionKind =
    timeline.pendingApprovals.length > 0
      ? "approval"
      : timeline.pendingInputs.length > 0
        ? "input"
        : undefined;
  const isStopping = pending["turn/stop"] === true || pending["turn/interrupt"] === true;
  const statusDisplay = resolveTurnStatusDisplay(
    timeline.activeTurnStatus,
    isStopping,
    decisionKind,
  );

  const hasDecision =
    timeline.pendingApprovals.length > 0 || timeline.pendingInputs.length > 0;

  return (
    <Screen>
      <NavBar
        title={sessionTitle}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <span>{hostName}</span>
            {streamState === "open" ? (
              <span className="inline-flex items-center gap-1 text-[var(--rm-success)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--rm-success)]" />
                <span>{t("session.live")}</span>
              </span>
            ) : null}
          </span>
        }
        onBack={onBack}
      />

      {/* Connection banner */}
      {connBanner.type !== "none" && connBanner.tone ? (
        <Banner
          tone={connBanner.tone === "warn" ? "neutral" : connBanner.tone}
          action={
            streamState === "exhausted" ? (
              <Button
                variant="plain"
                size="small"
                disabled={pending["stream/reconnect"] === true}
                onClick={() => void actions.reconnect()}
              >
                {t("session.reconnect")}
              </Button>
            ) : undefined
          }
        >
          {connBanner.message || (connBanner.messageKey ? t(connBanner.messageKey) : "")}
        </Banner>
      ) : null}

      {/* Operation failure banner */}
      {failure ? (
        <FailureBanner
          failure={failure.failure}
          operationKey={failure.operationKey}
          onDismiss={actions.dismissFailure}
        />
      ) : null}

      {/* Replay or resync notices */}
      {timeline.replayIncomplete ? (
        <Banner tone="neutral">
          {t("session.replayIncomplete")}
        </Banner>
      ) : null}

      {timeline.needsResync ? (
        <Banner tone="neutral">
          {t("session.resync")}
        </Banner>
      ) : null}

      {/* Run status bar */}
      <RunBar
        statusDisplay={statusDisplay}
        queuedCount={timeline.queuedTurnIds.length}
        stopping={isStopping}
        onStop={() => setStopSheetOpen(true)}
      />

      {/* Scrollable Timeline */}
      <ScreenContent hasDock ref={scroll.containerRef} className="[overflow-anchor:none]">
        {timeline.hasMoreHistory ? (
          <div className="flex justify-center py-2">
            <Button
              variant="plain"
              size="small"
              disabled={loadingEarlier}
              onClick={() => void actions.loadEarlier()}
            >
              {loadingEarlier ? t("session.loadingEarlier") : t("session.loadEarlier")}
            </Button>
          </div>
        ) : null}
        <ChatTimeline
          items={timeline.items}
          lastFailure={timeline.lastFailure}
        />
      </ScreenContent>

      {/* A row that arrives while the reader is reading further up is announced
          instead of silently missed: the count is the rows they have not seen,
          and an open decision takes precedence over it. */}
      {scroll.following ? null : (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-20 flex justify-center">
          <Button
            variant="secondary"
            size="small"
            className="pointer-events-auto shadow-lg"
            aria-label={t("session.backToLatest")}
            onClick={() => scroll.scrollToBottom()}
          >
            {attention > 0 && scroll.unread === 0
              ? t("session.needsDecision")
              : scroll.unread > 0
                ? t("session.backToLatestCount", { count: scroll.unread })
                : t("session.backToLatest")}
          </Button>
        </div>
      )}

      {/* Bottom Dock */}
      <ScreenDock>
        <div className="flex flex-col gap-2 w-full">
          {hasDecision ? (
            <DecisionArea
              approvals={timeline.pendingApprovals}
              inputs={timeline.pendingInputs}
              pending={pending}
              hostLabel={hostName}
              onDecideApproval={(approvalId, decision, attempt) =>
                void actions.respondApproval({ approvalId, decision, attempt })
              }
              onSubmitInput={(inputId, answers, attempt) =>
                void actions.respondInput({ inputId, answers, attempt })
              }
            />
          ) : null}

          <ChatComposer
            sending={pending["turn/start"] === true}
            disabled={timeline.archived}
            archived={timeline.archived}
            queued={active}
            onSend={actions.sendTurn}
          />
        </div>
      </ScreenDock>

      {/* Stop run Sheet */}
      <StopSheet
        open={stopSheetOpen}
        onClose={() => setStopSheetOpen(false)}
        onStopGraceful={() => {
          setStopSheetOpen(false);
          void actions.stop();
        }}
        onStopInterrupt={() => {
          setStopSheetOpen(false);
          void actions.interrupt();
        }}
      />
    </Screen>
  );
}
