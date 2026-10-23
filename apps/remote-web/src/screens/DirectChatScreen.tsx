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
import { Code2, Globe, Info, Lightbulb, Mail, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MinihRouterModel, RacpInlineAttachment } from "@minih-agent/shared";

import { ModelSheet } from "../components/ModelSheet.js";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatTimeline } from "../components/chat/ChatTimeline.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ModelPill, NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { Sheet } from "../components/ui/Sheet.js";
import { watchVisibility } from "../lib/app-state.js";
import { checkModelVisionCapability, isImageModel, resolveDirectModel } from "../lib/direct-chat/catalog.js";

import { copyText } from "../lib/clipboard.js";
import { IMAGE_PROTOCOL, resolveSendTarget, type SendTarget } from "../lib/direct-chat/target.js";
import type {
  DirectChatAttempt,
  DirectChatMedia,
  DirectChatTranscript,
} from "../lib/direct-chat/history-store.js";
import { isIdle, isImageConversation } from "../lib/direct-chat/history.js";
import { scopeKey } from "../lib/direct-chat/history-store.js";
import {
  base64ToBytes,
  createMediaUrl,
  probeImageDimensions,
  validateRasterImageBytes,
} from "../lib/direct-chat/media.js";
import {
  failureReasonKey,
  isRetryableFailure,
  modelChoiceGap,
  projectDirectTranscript,
  transcriptAsMarkdown,
} from "../lib/direct-chat/view.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import { createIdempotencyKey, createRequestId } from "../lib/ids.js";
import type { DirectChatTransaction } from "../lib/direct-chat/history-store.js";
import {
  directChatHistory,
  directChatRunner,
  directChatScope,
  directChatService,
  directChatStore,
  secureStore,
  subscribeDirectChat,
} from "../lib/runtime.js";
import { createDirectChatSecret } from "../lib/direct-chat/secret.js";
import { DirectChatInfoSheet } from "../components/direct/DirectChatInfoSheet.js";

/** How long typing pauses before the draft is written. */
const DRAFT_DEBOUNCE_MS = 500;

export type DirectChatScreenProps = {
  conversationId: string;
  /**
   * The model a not-yet-saved conversation was started on (ADR mobile-redesign
   * D2). Absent for a conversation opened from a list, whose model is on its
   * record.
   */
  draftModelId?: string;
  onBack: () => void;
  connection: DirectChatConnection | null;
  onConnect: () => void;
  /** Called after a change D1 must see (rename, archive, delete). */
  onChanged?: () => void;
  /** Start a fresh conversation, offered when this one no longer fits. */
  onNewConversation?: (modelId: string) => void;
  /** Open another conversation (e.g. on branch edit-and-resend). */
  onOpenConversation?: (conversationId: string) => void;
};

export function DirectChatScreen({
  conversationId,
  draftModelId,
  onBack,
  connection,
  onConnect,
  onChanged,
  onNewConversation,
  onOpenConversation,
}: DirectChatScreenProps) {
  const { t } = useTranslation();
  const history = directChatHistory();
  const runner = directChatRunner();
  const scope = directChatScope();

  const [transcript, setTranscript] = useState<DirectChatTranscript | null>(null);
  /** False until the first read finishes, so "new" is not a guess. */
  /**
   * The model a draft is on. A conversation that does not exist yet has no
   * record to hold it, and writing the choice to the account's remembered model
   * would move the next new chat (bug B2), so the draft owns it in this screen
   * until the first message saves the record.
   */
  const [draftModel, setDraftModel] = useState<string | null>(draftModelId ?? null);
  const [loaded, setLoaded] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [editingMessage, setEditingMessage] = useState<{ id: string; text: string; index: number } | null>(null);
  const [editText, setEditText] = useState("");
  const [seededDraft, setSeededDraft] = useState<string | null>(null);
  const [composerKey, setComposerKey] = useState(0);
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
  /**
   * Whether the conversation has a record yet, read through a ref so the flush
   * below is owned by the screen, not re-run on every transcript read: a
   * re-read after a send used to flush the just-sent text back as the draft.
   */
  const hasRecordRef = useRef(false);
  hasRecordRef.current = transcript !== null;

  const [accountDraft, setAccountDraft] = useState<string | null>(null);

  useEffect(() => {
    if (loaded && transcript === null && scope) {
      void history.accountDraft(scope).then((d: string | null) => {
        setAccountDraft(d);
      });
    } else if (transcript !== null) {
      setAccountDraft(null);
    }
  }, [loaded, transcript, scope, history]);

  const persistDraft = useCallback(
    (text: string) => {
      draftRef.current = text;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        draftTimer.current = null;
        if (hasRecordRef.current) {
          void history.setDraft(conversationId, draftRef.current);
        } else if (scope) {
          void history.setAccountDraft(scope, draftRef.current);
        }
      }, DRAFT_DEBOUNCE_MS);
    },
    [history, conversationId, scope],
  );

  /** A sent message is no longer a draft: forget it before anything flushes. */
  const clearDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    draftRef.current = "";
    if (scope) {
      void history.setAccountDraft(scope, "");
    }
  }, [history, scope]);

  useEffect(() => {
    const flush = () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = null;
      if (hasRecordRef.current) {
        void history.setDraft(conversationId, draftRef.current);
      } else if (scope) {
        void history.setAccountDraft(scope, draftRef.current);
      }
    };
    // Leaving the screen or the app must not lose what was typed.
    const unsubscribe = watchVisibility({ onHidden: flush, onVisible: () => {} });
    return () => {
      unsubscribe();
      flush();
    };
  }, [history, conversationId, scope]);
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
    setSeededDraft(null);
  }, [conversationId]);

  // A draft opened for a particular model starts on it, and re-opening the same
  // screen for another model must not keep the previous choice.
  useEffect(() => {
    setDraftModel(draftModelId ?? null);
  }, [conversationId, draftModelId]);

  useEffect(() => {
    void reload();
    // The runner announces every checkpoint and terminal state; re-reading is
    // how this view stays in step with a reply it does not own.
    const unsubscribe = subscribeDirectChat(() => void reload());
    return unsubscribe ?? undefined;
  }, [reload]);

  /**
   * Only this conversation's own reply matters here: other conversations stream
   * on their own (ADR §5), so their progress is D1's business, not a lock on
   * this composer.
   */
  const view = transcript
    ? projectDirectTranscript(transcript, {
        liveText: runner.streamingText(conversationId),
        noReplyText: t("directChat.noReply"),
      })
    : null;
  const conversation = transcript?.conversation ?? null;
  const attempts = transcript?.attempts ?? [];
  const idle = isIdle(attempts);
  const live = view?.liveAttempt ?? null;
  const archived = conversation?.archived === true;

  /**
   * The model the next send uses, resolved from the cached catalog. A stored
   * conversation uses the model on its record; a draft uses the model it was
   * opened on (ADR mobile-redesign D2), so switching model in an unsent
   * conversation works — that was bug B1 — without touching the account's
   * remembered model, which is bug B2.
   */
  const catalog: MinihRouterModel[] = connection?.models ?? [];
  const wantedModelId = conversation?.nextModelId ?? draftModel ?? connection?.lastModelId ?? null;
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
  /**
   * A draft is an image draft only when the model it was opened on cannot hold a
   * conversation: a model that declares both text and image output is a chat
   * model when the user started here (D1, "the entry point chooses").
   */
  const nextChoice = nextModel ? resolveDirectModel(nextModel) : null;
  const isImage = transcript
    ? isImageConversation(transcript.conversation, transcript.attempts)
    : nextModel !== null && nextChoice !== null && !nextChoice.usable && isImageModel(nextModel);
  // One decision for the composer, retry, regenerate and edit-resend, so an
  // image conversation can retry (bug B3) and a refusal always has a reason
  // (bug B4).
  const target = resolveSendTarget(nextModel, isImage);
  const usable = target.ok;
  const activeProtocol = target.ok
    ? target.protocol
    : isImage
      ? IMAGE_PROTOCOL
      : "openai-completions";
  const visionCap = nextModel ? checkModelVisionCapability(nextModel) : "unsupported";
  const supportsImages = visionCap === "supported" && !isImage;

  const resolveMedia = useCallback(async (mediaId: string) => {
    const store = directChatStore();
    const m = await store.media(mediaId);
    if (!m) return null;
    return {
      id: m.id,
      url: createMediaUrl(m),
      mime: m.mime,
      width: m.width ?? undefined,
      height: m.height ?? undefined,
    };
  }, []);
  /**
   * Why there is no model to send with: never chosen, or gone from the catalog.
   * The two absences get different words.
   */
  const modelGap = modelChoiceGap(wantedModelId, nextModel !== null);

  async function send(text: string, attachments?: RacpInlineAttachment[]): Promise<boolean> {
    if (!connection || !scope) return false;
    if (!nextModel || !usable) {
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

    const targetConvId = conversation?.id ?? conversationId;
    const mediaList: DirectChatMedia[] = [];
    if (!isImage && attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (!att.data) continue;
        const bytes = base64ToBytes(att.data);
        if (!bytes) {
          setSending(false);
          setNotice(t("directChat.invalidImage"));
          return false;
        }
        const valid = validateRasterImageBytes(bytes);
        if (!valid.ok) {
          setSending(false);
          setNotice(t("directChat.invalidImage"));
          return false;
        }
        const dims = await probeImageDimensions(bytes, att.mimeType || "image/png");
        const mediaId = `med-${createRequestId()}`;
        mediaList.push({
          id: mediaId,
          conversationId: targetConvId,
          scope,
          mime: att.mimeType || "image/png",
          byteLength: bytes.byteLength,
          width: dims?.width,
          height: dims?.height,
          createdAt: new Date().toISOString(),
          data: bytes,
        });
      }
    }

    if (mediaList.length > 0) {
      const store = directChatStore();
      await store.transact(async (tx: DirectChatTransaction) => {
        for (const m of mediaList) {
          tx.putMedia(m);
        }
      });
    }

    const mediaIds = mediaList.map((m) => m.id);
    const saved = await history.beginTurn({
      conversationId: conversation?.id ?? null,
      scope,
      text,
      operation: isImage ? "image-generation" : undefined,
      imageModel: isImage ? true : undefined,
      mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
      modelId: nextModel.id,
      modelLabel: nextModel.id,
      protocol: activeProtocol,
      now: new Date().toISOString(),
      newConversationId: conversationId,
      newMessageId: `msg-${createRequestId()}`,
      newAttemptId: `att-${createIdempotencyKey()}`,
    });
    if (!saved.ok) {
      // Clean up orphaned media on failure
      if (mediaList.length > 0) {
        const store = directChatStore();
        await store.transact(async (tx: DirectChatTransaction) => {
          for (const m of mediaList) {
            tx.deleteMedia(m.id);
          }
        });
      }
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
    // `beginTurn` stored an empty draft with the message; the text in hand is
    // the message now, so no later flush may write it back as a draft.
    clearDraft();
    // Now that a real conversation exists, the account remembers the model it
    // uses — the right slot per operation, so an image job never becomes the
    // next new chat's model (D2). A draft that was never sent never gets here.
    if (isImage) directChatService().rememberImageModel(nextModel.id);
    else directChatService().rememberModel(nextModel.id);
    await reload();
    const started = await runner.start({
      conversationId: saved.conversation.id,
      scope,
      attempt: saved.attempt,
      model: nextModel,
      protocol: activeProtocol,
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
      await history.setNextModel(saved.conversation.id, nextModel.id, activeProtocol, new Date().toISOString());
    }
    await reload();
    onChanged?.();
    return true;
  }

  /** Why a turn cannot be sent, in words. */
  const refusalNotice = useCallback(
    (value: SendTarget): string | null => {
      if (value.ok) return null;
      if (value.reason === "no-model") return t("directChat.noModel");
      if (value.reason === "not-an-image-model") return t("directChat.notAnImageModel");
      return t("directChat.modelUnavailable");
    },
    [t],
  );

  /** D3 in its archived state offers restore instead of an input. */
  async function restore(): Promise<void> {
    const outcome = await history.setArchived(conversationId, false, new Date().toISOString());
    if (!outcome.ok) setNotice(t("directChat.saveFailed"));
    await reload();
    onChanged?.();
  }

  async function retry(attempt: DirectChatAttempt) {
    // A retry sends the same operation the turn used, which for an image
    // conversation is the image endpoint — the old guard asked the chat
    // classifier first and always got "unusable" (bug B3).
    if (!scope) {
      setNotice(t("chats.connect"));
      return;
    }
    const blocked = refusalNotice(target);
    if (blocked !== null || !nextModel || !target.ok) {
      setNotice(blocked ?? t("directChat.modelUnavailable"));
      return;
    }
    const key = await createDirectChatSecret(secureStore()).read();
    if (!key) {
      setNotice(t("directChat.failure.unauthorized"));
      return;
    }
    const outcome = await runner.retry({
      attempt,
      scope,
      model: nextModel,
      protocol: target.protocol,
      authKey: key,
    });
    if (!outcome.ok) {
      setNotice(outcome.reason === "foreign-scope" ? t("directChat.foreignScope") : t("directChat.busy"));
    }
    await reload();
    onChanged?.();
  }

  const copyMessage = useCallback(
    async (text: string) => {
      // A copy that did not happen must not look like one that did (bug B11).
      const outcome = await copyText(text, navigator.clipboard);
      setNotice(outcome.ok ? null : t("directChat.copyFailed"));
    },
    [t],
  );

  async function regenerateMessage(messageId: string): Promise<void> {
    if (!scope || !transcript) {
      setNotice(t("directChat.modelUnavailable"));
      return;
    }
    const blocked = refusalNotice(target);
    if (blocked !== null || !nextModel || !target.ok) {
      setNotice(blocked ?? t("directChat.modelUnavailable"));
      return;
    }
    const msg = transcript.messages.find((m) => m.id === messageId);
    if (!msg) return;
    const attempt = transcript.attempts.find(
      (a) => a.id === msg.attemptId || a.assistantMessageId === messageId,
    );
    if (!attempt) return;
    const key = await createDirectChatSecret(secureStore()).read();
    if (!key) {
      setNotice(t("directChat.failure.unauthorized"));
      return;
    }
    const outcome = await runner.regenerate({
      attempt,
      scope,
      model: nextModel,
      protocol: target.protocol,
      authKey: key,
    });
    if (!outcome.ok) {
      setNotice(outcome.reason === "foreign-scope" ? t("directChat.foreignScope") : t("directChat.busy"));
    }
    await reload();
    onChanged?.();
  }

  function handleStartEditResend(messageId: string) {
    if (!transcript) return;
    const idx = transcript.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const msg = transcript.messages[idx];
    if (msg.role !== "user") return;
    setEditingMessage({ id: msg.id, text: msg.text, index: idx });
    setEditText(msg.text);
  }

  async function handleConfirmEditResend(): Promise<void> {
    if (!editingMessage || !scope || !transcript) {
      setNotice(t("directChat.modelUnavailable"));
      return;
    }
    const blocked = refusalNotice(target);
    if (blocked !== null || !nextModel || !target.ok) {
      setNotice(blocked ?? t("directChat.modelUnavailable"));
      return;
    }
    const key = await createDirectChatSecret(secureStore()).read();
    if (!key) {
      setNotice(t("directChat.failure.unauthorized"));
      return;
    }
    const newBranchId = `conv-${Date.now().toString(36)}`;
    const edited = await history.editAndResend({
      sourceConversationId: conversationId,
      messageIndex: editingMessage.index,
      newText: editText.trim(),
      newConversationId: newBranchId,
      newMessageId: `msg-${createRequestId()}`,
      newAttemptId: `att-${createIdempotencyKey()}`,
      now: new Date().toISOString(),
      modelId: nextModel.id,
      modelLabel: nextModel.id,
      protocol: activeProtocol,
    });
    if (!edited.ok) {
      setNotice(edited.reason === "busy" ? t("directChat.busy") : t("directChat.saveFailed"));
      return;
    }
    setEditingMessage(null);
    const started = await runner.start({
      conversationId: edited.conversation.id,
      scope,
      attempt: edited.attempt,
      model: nextModel,
      protocol: activeProtocol,
      authKey: key,
    });
    if (!started.ok) {
      setNotice(started.reason === "busy" ? t("directChat.busy") : null);
    }
    onChanged?.();
    if (onOpenConversation) {
      onOpenConversation(edited.conversation.id);
    } else {
      await reload();
    }
  }

  const fillSuggestion = (promptText: string) => {
    setSeededDraft(promptText);
    setComposerKey((k) => k + 1);
    persistDraft(promptText);
  };

  const hasMessages = Boolean(view && view.items.length > 0);

  return (
    <Screen aurora={!hasMessages}>
      <NavBar
        solid={hasMessages}
        title={isNew ? t("chats.newChat") : (conversation?.title ?? t("chats.title"))}
        onBack={onBack}
        backLabel={t("common.back")}
        modelPill={
          connection ? (
            <ModelPill
              label={nextModel?.id ?? t("chats.modelUnset")}
              disabled={!idle}
              onClick={() => setModelsOpen(true)}
            />
          ) : undefined
        }
        trailing={
          <Button variant="plain" size="icon" aria-label={t("directChat.info")} onClick={() => setInfoOpen(true)}>
            <Info className="h-5 w-5 stroke-[1.8]" aria-hidden="true" />
          </Button>
        }
      />

      <ScreenContent hasDock className="[overflow-anchor:none]">
        {view && view.items.length > 0 ? (
          <>
            <ChatTimeline
              items={view.items}
              resolveMedia={resolveMedia}
              onCopyMessage={(item) => void copyMessage(item.text)}
              onRegenerateMessage={(item) => void regenerateMessage(item.id)}
              onEditResendMessage={(item) => handleStartEditResend(item.id)}
            />
            {live ? (
              <div className="mt-2 flex items-center gap-2 px-1" aria-live="polite">
                <span className="rm-caret" aria-hidden="true" />
                <span className="rm-text-shimmer text-[13px]">{t("chats.replying")}</span>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState
            aurora={false}
            orb={true}
            title={t("directChat.heroTitle")}
            description={t("directChat.heroSubtitle")}
            suggestions={
              !foreignScope && !archived ? (
                <div className="grid grid-cols-2 gap-2.5 text-left">
                  {[
                    {
                      key: "email",
                      icon: Mail,
                      title: t("directChat.sug.email.title"),
                      sub: t("directChat.sug.email.sub"),
                      prompt: t("directChat.sug.email.prompt"),
                    },
                    {
                      key: "code",
                      icon: Code2,
                      title: t("directChat.sug.code.title"),
                      sub: t("directChat.sug.code.sub"),
                      prompt: t("directChat.sug.code.prompt"),
                    },
                    {
                      key: "translate",
                      icon: Globe,
                      title: t("directChat.sug.translate.title"),
                      sub: t("directChat.sug.translate.sub"),
                      prompt: t("directChat.sug.translate.prompt"),
                    },
                    {
                      key: "ideas",
                      icon: Lightbulb,
                      title: t("directChat.sug.ideas.title"),
                      sub: t("directChat.sug.ideas.sub"),
                      prompt: t("directChat.sug.ideas.prompt"),
                    },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => fillSuggestion(item.prompt)}
                        className="flex flex-col items-start rounded-[18px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] p-3.5 text-left backdrop-blur-md transition-transform duration-150 active:scale-[0.975] active:bg-[var(--rm-bg-surface-2)]"
                      >
                        <span
                          aria-hidden="true"
                          className="mb-2 grid h-8 w-8 place-items-center rounded-[10px] bg-[var(--rm-bg-surface-2)] text-[var(--rm-accent-2)]"
                        >
                          <Icon className="h-[18px] w-[18px] stroke-[2]" />
                        </span>
                        <b className="block text-[14px] font-semibold leading-[19px] text-[var(--rm-text-primary)]">
                          {item.title}
                        </b>
                        <small className="mt-0.5 block text-[12px] leading-[16px] text-[var(--rm-text-muted)]">
                          {item.sub}
                        </small>
                      </button>
                    );
                  })}
                </div>
              ) : undefined
            }
          />
        )}

        {foreignScope ? (
          <Callout tone="neutral" className="mt-3">
            {t("directChat.readOnlyScope")}
          </Callout>
        ) : null}

        {view?.retryable && !foreignScope ? (
          <Callout
            tone={view.retryable.state === "failed" ? "error" : "warn"}
            className="mt-3 flex items-center gap-2"
          >
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
          </Callout>
        ) : null}

        {notice ? (
          <Callout tone="error" className="mt-3 py-2.5 text-[13px]">
            {notice}
          </Callout>
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
        ) : archived ? (
          <Button variant="secondary" size="large" onClick={() => void restore()}>
            {t("directChat.restore")}
          </Button>
        ) : live ? (
          <Button variant="secondary" size="large" onClick={() => void runner.stop(conversationId)}>
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
        ) : !loaded || (transcript === null && accountDraft === null) ? (
          // The composer reads its first text once, when it mounts; mounting it
          // before the transcript arrives would show an empty box where the
          // saved draft belongs.
          null
        ) : (
          <ChatComposer
            key={composerKey}
            sending={sending}
            disabled={false}
            archived={false}
            queued={false}
            hideAttachments={!supportsImages}
            placeholder={isImage ? t("imageGen.promptPlaceholder") : undefined}
            initialText={seededDraft ?? conversation?.draft ?? accountDraft ?? ""}
            onDraftChange={persistDraft}
            onSend={async (payload) => {
              setSeededDraft(null);
              const sent = await send(payload.text, payload.attachments);
              return sent;
            }}
          />
        )}
      </ScreenDock>

      {connection ? (
        <ModelSheet
          open={modelsOpen}
          models={catalog}
          mode={isImage ? "image" : "chat"}
          selectedId={wantedModelId}
          onClose={() => setModelsOpen(false)}
          onSelect={(model) => {
            const choice = resolveDirectModel(model);
            // The operation is what the row can do, not what the sheet shows:
            // an image-only row picks the image protocol, a chat row its own.
            const protocol: string = isImage
              ? "openai-images"
              : choice.usable
                ? choice.protocol
                : "";
            if (!isImage && !choice.usable) return;
            if (isImage && !isImageModel(model)) return;
            const previous = wantedModelId;
            if (conversation) {
              void history
                .setNextModel(conversation.id, model.id, protocol, new Date().toISOString())
                .then(reload);
            } else {
              // A draft has no record yet, so the choice lives here until the
              // first message creates one (bug B1).
              setDraftModel(model.id);
            }
            if (previous && previous !== model.id) {
              setNotice(t("directChat.modelChanged", { model: model.id }));
            }
          }}
        />
      ) : null}

      <Sheet
        open={editingMessage !== null}
        onClose={() => setEditingMessage(null)}
        title={t("message.editResend")}
      >
        <div className="flex flex-col gap-3 pt-2">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-[12px] border border-[var(--rm-border)] bg-[var(--rm-bg-inset)] p-3 text-[16px] leading-[22px] text-[var(--rm-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--rm-accent)]"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="medium" onClick={() => setEditingMessage(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="medium"
              disabled={!editText.trim()}
              onClick={() => void handleConfirmEditResend()}
            >
              {t("composer.send")}
            </Button>
          </div>
        </div>
      </Sheet>

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
          const outcome = await history.setArchived(
            conversationId,
            !conversation.archived,
            new Date().toISOString(),
          );
          if (!outcome.ok) {
            // The sheet offers "stop and archive" instead, so this is the
            // path a caller that ignored `idle` ends up on (bug B6).
            setNotice(t("directChat.stopFirst"));
            return;
          }
          await reload();
          onChanged?.();
          if (!conversation.archived) onBack();
        }}
        onStopThenArchive={async () => {
          await runner.stop(conversationId);
          const outcome = await history.setArchived(conversationId, true, new Date().toISOString());
          if (!outcome.ok) setNotice(t("directChat.saveFailed"));
          await reload();
          onChanged?.();
          if (outcome.ok) onBack();
        }}
        onCopy={async () => {
          if (!transcript) {
            setNotice(t("directChat.copyFailed"));
            return false;
          }
          const outcome = await copyText(transcriptAsMarkdown(transcript), navigator.clipboard);
          if (!outcome.ok) setNotice(t("directChat.copyFailed"));
          return outcome.ok;
        }}
        onDelete={async () => {
          await runner.stop(conversationId);
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
