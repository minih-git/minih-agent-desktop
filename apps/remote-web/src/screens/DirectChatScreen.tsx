/**
 * D3: one direct conversation (ADR mobile-direct-gateway-chat §3, §5, §6).
 *
 * A container over the local repository and the request runner, rendering the
 * same presentation pieces as a remote session: `ChatTimeline` for the rows,
 * `ChatComposer` for the input, `ModelSheet` for the model. No RACP event, cursor
 * or remote session id appears anywhere - the conversation is a local record.
 *
 * The screen is a view over the runtime, not the owner of the reply: the runner
 * keeps streaming when the user leaves for D1 or Computers, so everything here
 * re-reads the store on change instead of holding the truth in component state.
 */
import { ArrowLeft, Info, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MinihRouterModel } from "@minih-agent/shared";

import { ModelSheet } from "../components/ModelSheet.js";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatTimeline } from "../components/chat/ChatTimeline.js";
import { Button } from "../components/ui/Button.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { watchVisibility } from "../lib/app-state.js";
import { resolveDirectModel } from "../lib/direct-chat/catalog.js";
import type { DirectChatAttempt, DirectChatTranscript } from "../lib/direct-chat/history-store.js";
import { isIdle } from "../lib/direct-chat/history.js";
import { scopeKey } from "../lib/direct-chat/history-store.js";
import {
  failureReasonKey,
  isRetryableFailure,
  modelChoiceGap,
  projectDirectTranscript,
  transcriptAsMarkdown,
} from "../lib/direct-chat/view.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import { createIdempotencyKey, createRequestId } from "../lib/ids.js";
import {
  directChatHistory,
  directChatRunner,
  directChatScope,
  secureStore,
  subscribeDirectChat,
} from "../lib/runtime.js";
import { createDirectChatSecret } from "../lib/direct-chat/secret.js";
import { DirectChatInfoSheet } from "../components/direct/DirectChatInfoSheet.js";

/** How long typing pauses before the draft is written. */
const DRAFT_DEBOUNCE_MS = 500;

export type DirectChatScreenProps = {
  conversationId: string;
  onBack: () => void;
  connection: DirectChatConnection | null;
  onConnect: () => void;
  /** Called after a change D1 must see (rename, archive, delete). */
  onChanged?: () => void;
  /** Start a fresh conversation, offered when this one no longer fits. */
  onNewConversation?: (modelId: string) => void;
};

export function DirectChatScreen({
  conversationId,
  onBack,
  connection,
  onConnect,
  onChanged,
  onNewConversation,
}: DirectChatScreenProps) {
  const { t } = useTranslation();
  const history = directChatHistory();
  const runner = directChatRunner();
  const scope = directChatScope();

  const [transcript, setTranscript] = useState<DirectChatTranscript | null>(null);
  /** False until the first read finishes, so "new" is not a guess. */
  const [loaded, setLoaded] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busyElsewhere, setBusyElsewhere] = useState(false);

  /**
   * Reads are numbered, and a result is applied only if it is still the newest
   * and still about this conversation: switching conversations quickly would
   * otherwise let an older read paint the new screen with the old transcript.
   */
  const readSeq = useRef(0);
  /**
   * The draft is written while typing, debounced, and flushed when the screen
   * goes away or the app is backgrounded - so leaving D3 never loses a
   * half-written message. A conversation that has no record yet keeps its draft
   * in this component only: the ADR starts history at the first message, and a
   * draft is not a message.
   */
  const draftRef = useRef<string>("");
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistDraft = useCallback(
    (text: string) => {
      draftRef.current = text;
      if (!transcript) return;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        draftTimer.current = null;
        void history.setDraft(conversationId, draftRef.current);
      }, DRAFT_DEBOUNCE_MS);
    },
    [history, conversationId, transcript],
  );

  useEffect(() => {
    const flush = () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = null;
      if (!transcript) return;
      void history.setDraft(conversationId, draftRef.current);
    };
    // Leaving the screen or the app must not lose what was typed.
    const unsubscribe = watchVisibility({ onHidden: flush, onVisible: () => {} });
    return () => {
      unsubscribe();
      flush();
    };
  }, [history, conversationId, transcript]);
  const reload = useCallback(async () => {
    readSeq.current += 1;
    const mine = readSeq.current;
    const next = await history.transcript(conversationId);
    if (mine !== readSeq.current) return;
    if (next && next.conversation.id !== conversationId) return;
    setTranscript(next);
    setLoaded(true);
  }, [history, conversationId]);

  // A new conversation starts from an empty screen, not the previous one's text.
  useEffect(() => {
    setTranscript(null);
    setLoaded(false);
    setNotice(null);
  }, [conversationId]);

  useEffect(() => {
    void reload();
    // The runner announces every checkpoint and terminal state; re-reading is
    // how this view stays in step with a reply it does not own.
    const unsubscribe = subscribeDirectChat(() => void reload());
    return unsubscribe ?? undefined;
  }, [reload]);

  useEffect(() => {
    // A live reply in another conversation: this screen must offer Stop or
    // Return rather than queueing hidden work.
    const state = runner.state();
    setBusyElsewhere(state.phase === "running" && state.conversationId !== conversationId);
  }, [runner, conversationId, transcript]);

  const view = transcript ? projectDirectTranscript(transcript, { liveText: runner.streamingText() }) : null;
  const conversation = transcript?.conversation ?? null;
  const attempts = transcript?.attempts ?? [];
  const idle = isIdle(attempts);
  const live = view?.liveAttempt ?? null;
  const archived = conversation?.archived === true;

  /**
   * The model the next send uses, resolved from the cached catalog. A new
   * conversation starts on the account's last explicit choice, and a stored one
   * on what it remembered.
   */
  const catalog: MinihRouterModel[] = connection?.models ?? [];
  const wantedModelId = conversation?.nextModelId ?? connection?.lastModelId ?? null;
  const nextModel = catalog.find((model) => model.id === wantedModelId) ?? null;
  /** True for a conversation opened before its first message exists. */
  const isNew = loaded && transcript === null;
  /**
   * The conversation belongs to another access key. Sending would carry this
   * device's key to it, so the screen is read-only rather than merely disabled.
   */
  const foreignScope = Boolean(
    conversation && scope && scopeKey(conversation.scope) !== scopeKey(scope),
  );
  const nextChoice = nextModel ? resolveDirectModel(nextModel) : null;
  const usable = nextChoice?.usable === true;
  /**
   * Why there is no model to send with: never chosen, or gone from the catalog.
   * The two absences get different words.
   */
  const modelGap = modelChoiceGap(wantedModelId, nextModel !== null);

  async function send(text: string): Promise<boolean> {
    if (!connection || !scope) return false;
    if (!nextModel || nextChoice?.usable !== true) {
      // Saying nothing here was the bug: the composer merely did not react.
      setNotice(t(modelGap === "none" ? "directChat.noModel" : "directChat.modelUnavailable"));
      setModelsOpen(true);
      return false;
    }
    // A new conversation has no record until this save: the ADR puts history's
    // start at the first user message, not at opening the screen.
    if (!conversation && !isNew) return false;
    setSending(true);
    setNotice(null);
    const key = await createDirectChatSecret(secureStore()).read();
    if (!key) {
      setSending(false);
      setNotice(t("directChat.failure.unauthorized"));
      return false;
    }
    const saved = await history.beginTurn({
      conversationId: conversation?.id ?? null,
      scope,
      text,
      modelId: nextModel.id,
      modelLabel: nextModel.id,
      protocol: nextChoice.protocol,
      now: new Date().toISOString(),
      newConversationId: conversationId,
      newMessageId: `msg-${createRequestId()}`,
      newAttemptId: `att-${createIdempotencyKey()}`,
    });
    if (!saved.ok) {
      // Nothing was written, so the draft stays and nothing is sent.
      setSending(false);
      setNotice(
        saved.reason === "busy"
          ? t("directChat.busy")
          : saved.reason === "archived"
            ? t("directChat.archivedHint")
            : t("directChat.saveFailed"),
      );
      return false;
    }
    await reload();
    const started = await runner.start({
      conversationId: saved.conversation.id,
      scope,
      attempt: saved.attempt,
      model: nextModel,
      protocol: nextChoice.protocol,
      authKey: key,
    });
    setSending(false);
    if (!started.ok) {
      setNotice(
        started.reason === "busy"
          ? t("directChat.busy")
          : started.reason === "foreign-scope"
            ? t("directChat.foreignScope")
            : null,
      );
      return false;
    }
    // The new conversation now exists: read it back under its own id.
    if (saved.conversation.id !== conversationId) {
      await history.setNextModel(saved.conversation.id, nextModel.id, nextChoice.protocol, new Date().toISOString());
    }
    await reload();
    onChanged?.();
    return true;
  }

  /** D3 in its archived state offers restore instead of an input. */
  async function restore(): Promise<void> {
    await history.setArchived(conversationId, false, new Date().toISOString());
    await reload();
    onChanged?.();
  }

  async function retry(attempt: DirectChatAttempt) {
    // A retry sends: without a connected account there is no key to send with.
    if (!scope || !nextModel || nextChoice?.usable !== true) return;
    const key = await createDirectChatSecret(secureStore()).read();
    if (!key) {
      setNotice(t("directChat.failure.unauthorized"));
      return;
    }
    const outcome = await runner.retry({
      attempt,
      scope,
      model: nextModel,
      protocol: nextChoice.protocol,
      authKey: key,
    });
    if (!outcome.ok) {
      setNotice(outcome.reason === "foreign-scope" ? t("directChat.foreignScope") : t("directChat.busy"));
    }
    await reload();
    onChanged?.();
  }

  return (
    <Screen>
      <NavBar
        title={conversation?.title ?? t("chats.title")}
        onBack={onBack}
        backLabel={t("common.back")}
        trailing={
          <Button variant="plain" size="icon" aria-label={t("directChat.info")} onClick={() => setInfoOpen(true)}>
            <Info className="h-5 w-5 stroke-[1.8]" aria-hidden="true" />
          </Button>
        }
      />

      {connection ? (
        <button
          type="button"
          onClick={() => setModelsOpen(true)}
          disabled={!idle}
          className="mx-3 mb-1 flex min-h-[34px] shrink-0 items-center gap-1.5 self-start rounded-full bg-[var(--rm-bg-inset)] px-3 text-[13px] text-[var(--rm-text-secondary)] disabled:opacity-50"
        >
          <span className="truncate">{nextModel?.id ?? t("chats.modelUnset")}</span>
        </button>
      ) : null}

      <ScreenContent hasDock className="[overflow-anchor:none]">
        {view && view.items.length > 0 ? (
          <ChatTimeline items={view.items} />
        ) : (
          <div className="px-4 py-10 text-center text-[15px] leading-[22px] text-[var(--rm-text-muted)]">
            {t("directChat.startHint")}
          </div>
        )}

        {foreignScope ? (
          <div className="mt-3 rounded-[12px] bg-[var(--rm-bg-inset)] px-3 py-2 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
            {t("directChat.readOnlyScope")}
          </div>
        ) : null}

        {view?.retryable && !foreignScope ? (
          <div className="mt-3 flex items-center gap-2 rounded-[12px] bg-[var(--rm-bg-inset)] px-3 py-2 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
            <span className="min-w-0 flex-1">
              {view.retryable.state === "stopped"
                ? t("directChat.state.stopped")
                : view.retryable.state === "interrupted"
                  ? t("directChat.state.interrupted")
                  : // A failure says what failed, not merely that it failed.
                    t(failureReasonKey(view.retryable.errorKind))}
            </span>
            {isRetryableFailure(view.retryable.errorKind) ? (
              <Button variant="secondary" size="small" disabled={!idle} onClick={() => void retry(view.retryable!)}>
                <span className="inline-flex items-center gap-1">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("directChat.retry")}
                </span>
              </Button>
            ) : (
              // The request is what is too big: another conversation is the fix.
              <Button
                variant="secondary"
                size="small"
                disabled={!idle || !nextModel}
                onClick={() => nextModel && onNewConversation?.(nextModel.id)}
              >
                {t("directChat.newChat")}
              </Button>
            )}
          </div>
        ) : null}

        {notice ? (
          <p className="mt-2 px-1 text-[13px] leading-[18px] text-[var(--rm-error)]">{notice}</p>
        ) : null}
      </ScreenContent>

      <ScreenDock>
        {foreignScope ? (
          // Read-only: no composer and no retry, because either would send.
          <p className="px-1 text-center text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
            {t("directChat.readOnlyScope")}
          </p>
        ) : !connection ? (
          // Not connected: the input area explains and offers the way in.
          <Button variant="primary" size="large" onClick={onConnect}>
            {t("chats.connect")}
          </Button>
        ) : busyElsewhere ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
              {t("directChat.otherConversation")}
            </span>
            <Button variant="secondary" size="small" onClick={onBack}>
              <span className="inline-flex items-center gap-1">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("directChat.return")}
              </span>
            </Button>
            <Button variant="secondary" size="small" onClick={() => void runner.stop()}>
              <span className="inline-flex items-center gap-1">
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                {t("directChat.stop")}
              </span>
            </Button>
          </div>
        ) : archived ? (
          <Button variant="secondary" size="large" onClick={() => void restore()}>
            {t("directChat.restore")}
          </Button>
        ) : live ? (
          <Button variant="secondary" size="large" onClick={() => void runner.stop()}>
            <span className="inline-flex items-center justify-center gap-1.5">
              <Square className="h-4 w-4" aria-hidden="true" />
              {t("directChat.stop")}
            </span>
          </Button>
        ) : !usable ? (
          // No usable model - gone from the catalog, forbidden, or a new
          // conversation that has not chosen one. History stays readable and the
          // sheet is the remedy, so sending is unavailable rather than silent.
          <div className="flex flex-col gap-2">
            <p className="text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {modelGap === "none" ? t("directChat.noModel") : t("directChat.modelUnavailable")}
            </p>
            <Button variant="secondary" size="large" onClick={() => setModelsOpen(true)}>
              {t("directChat.chooseModel")}
            </Button>
          </div>
        ) : !loaded ? (
          // The composer reads its first text once, when it mounts; mounting it
          // before the transcript arrives would show an empty box where the
          // saved draft belongs.
          null
        ) : (
          <ChatComposer
            sending={sending}
            disabled={false}
            archived={false}
            queued={false}
            hideAttachments
            initialText={conversation?.draft ?? ""}
            onDraftChange={persistDraft}
            onSend={async (payload) => {
              const sent = await send(payload.text);
              return sent;
            }}
          />
        )}
      </ScreenDock>

      {connection ? (
        <ModelSheet
          open={modelsOpen}
          models={catalog}
          selectedId={conversation?.nextModelId ?? null}
          onClose={() => setModelsOpen(false)}
          onSelect={(model) => {
            const choice = resolveDirectModel(model);
            if (!choice.usable || !conversation) return;
            const previous = conversation.nextModelId;
            void history
              .setNextModel(conversation.id, model.id, choice.protocol, new Date().toISOString())
              .then(reload);
            // The separator the ADR asks for is a stored fact, not a UI one: it
            // appears in the transcript because this reply ran on another model.
            if (previous && previous !== model.id) setNotice(t("directChat.modelChanged", { model: model.id }));
          }}
        />
      ) : null}

      <DirectChatInfoSheet
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        transcript={transcript}
        onRename={async (title) => {
          await history.rename(conversationId, title, new Date().toISOString());
          await reload();
          onChanged?.();
        }}
        onTogglePin={async () => {
          if (!conversation) return;
          await history.setPinned(conversationId, !conversation.pinned, new Date().toISOString());
          await reload();
          onChanged?.();
        }}
        onArchive={async () => {
          if (!conversation) return;
          await history.setArchived(conversationId, !conversation.archived, new Date().toISOString());
          await reload();
          onChanged?.();
          if (!conversation.archived) onBack();
        }}
        onCopy={async () => {
          if (!transcript) return false;
          try {
            await navigator.clipboard.writeText(transcriptAsMarkdown(transcript));
            return true;
          } catch {
            return false;
          }
        }}
        onDelete={async () => {
          const removed = await history.remove(conversationId);
          if (removed.ok) {
            onChanged?.();
            onBack();
          }
          return removed.ok;
        }}
        idle={idle}
      />
    </Screen>
  );
}
