/**
 * Studio root screen (ADR mobile-redesign D3, bug B7).
 *
 * Replaces the old "Images" segment inside Chats. Displays a day-grouped
 * gallery of the account's image conversations (`studioCards` + `groupByDay`),
 * live generating cards with blur-to-sharp reveal, a prompt composer that
 * drives `history.beginTurn` (`operation: "image-generation"`) + `runner.start`
 * on the OpenAI Images plane, the active image model pill (`resolveStudioModel`),
 * and a full-screen viewer for completed images.
 *
 * The first release sends one image per request and exposes no invented aspect
 * ratio or count controls (ADR D3).
 */
import { Router, Sparkles, Square, Wand2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { ModelSheet } from "../components/ModelSheet.js";
import { StudioArtCard, StudioViewerModal } from "../components/studio/StudioViewer.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ModelPill, NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { Sheet } from "../components/ui/Sheet.js";
import { Toast } from "../components/ui/Toast.js";
import { submitsOnEnter } from "../lib/composer-send.js";
import { isImageModel, resolveStudioModel } from "../lib/direct-chat/catalog.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import { scopeDependency } from "../lib/direct-chat/history-store.js";
import type { DirectChatTranscript } from "../lib/direct-chat/history-store.js";
import { createMediaUrlCache, type MediaUrlCache } from "../lib/direct-chat/media-cache.js";
import { createMediaUrl } from "../lib/direct-chat/media.js";
import { createDirectChatSecret } from "../lib/direct-chat/secret.js";
import {
  groupByDay,
  splitStudioCards,
  studioCards,
  studioRetryModel,
  studioSubmitRefusal,
  type StudioCard,
  type StudioDayKey,
} from "../lib/direct-chat/studio.js";
import { IMAGE_PROTOCOL } from "../lib/direct-chat/target.js";
import { createIdempotencyKey, createRequestId } from "../lib/ids.js";
import {
  directChatHistory,
  directChatRunner,
  directChatScope,
  directChatService,
  notifyDirectChatChanged,
  refreshDirectModels,
  secureStore,
  subscribeDirectChat,
} from "../lib/runtime.js";

export type StudioScreenProps = {
  connection: DirectChatConnection | null;
  gatewayConfigured: boolean;
  onConnect: () => void;
  onOpenSettings: () => void;
  onConnectionChanged?: () => void;
  onSwitchToChats?: (modelId: string) => void;
};

export function StudioScreen({
  connection,
  gatewayConfigured,
  onConnect,
  onOpenSettings,
  onConnectionChanged,
  onSwitchToChats,
}: StudioScreenProps) {
  const { t } = useTranslation();
  const history = directChatHistory();
  const runner = directChatRunner();
  const connectedScope = directChatScope();
  /**
   * The scope as a stable string. `directChatScope()` builds a fresh object on
   * every call, so an effect that depends on it re-runs on every render — the
   * reload loop this screen shipped with. The key is what actually changes when
   * the account does.
   */
  const connectedScopeKey = scopeDependency(connectedScope);

  const [transcripts, setTranscripts] = useState<DirectChatTranscript[]>([]);
  const [chosenModelId, setChosenModelId] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [viewerCardId, setViewerCardId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StudioCard | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [revealingIds, setRevealingIds] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * Object URLs are owned by a cache, so deleting a picture and leaving the
   * screen both revoke them instead of holding the blobs for the page's life.
   */
  const [mediaCache] = useState<MediaUrlCache>(() =>
    createMediaUrlCache({ create: createMediaUrl, revoke: (url) => URL.revokeObjectURL(url) }),
  );
  const prevGeneratingIdsRef = useRef<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Drop one cached object URL. Deleting an image must not leave its blob pinned
   * for the life of the page.
   */
  const releaseMediaUrl = useCallback(
    (mediaId: string) => mediaCache.release(mediaId),
    [mediaCache],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // Read the scope inside the effect: the dependency is its key, and the
      // object itself is new on every render.
      const scope = directChatScope() ?? (await history.lastScope());
      if (!scope) {
        if (!cancelled) setTranscripts([]);
        return;
      }
      const summaries = await history.list(scope);
      const imageSummaries = summaries.filter((row) => row.isImage === true);
      const loaded = await Promise.all(
        imageSummaries.map((row) => history.transcript(row.conversation.id)),
      );
      if (cancelled) return;
      const valid = loaded.filter((item): item is DirectChatTranscript => item !== null);
      for (const tr of valid) {
        for (const media of tr.media ?? []) mediaCache.urlFor(media);
      }
      setTranscripts(valid);
    };
    void load();
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, connectedScopeKey]);

  /**
   * Every blob URL this screen minted belongs to one account's images. On
   * unmount (or when the account changes) none of them can be shown again, so
   * they are revoked instead of being held for the life of the page.
   */
  useEffect(() => {
    return () => mediaCache.releaseAll();
  }, [mediaCache, connectedScopeKey]);

  const cards = useMemo(() => studioCards(transcripts), [transcripts]);
  // Each day leads with the cards that are not finished artwork: a generating or
  // failed card is full width, the completed ones tile under it (D).
  const dayGroups = useMemo(
    () => groupByDay(cards).map((group) => ({ ...group, ...splitStudioCards(group.cards) })),
    [cards],
  );

  // Track cards that transition from "generating" to "complete" so they play
  // the blur-to-sharp reveal sweep and surface a completion toast.
  useEffect(() => {
    const currentGen = new Set(
      cards.filter((c) => c.status === "generating").map((c) => c.id),
    );
    const newlyDone: string[] = [];
    for (const prevId of prevGeneratingIdsRef.current) {
      const match = cards.find((c) => c.id === prevId);
      if (match && match.status === "complete") {
        newlyDone.push(prevId);
      }
    }
    prevGeneratingIdsRef.current = currentGen;
    if (newlyDone.length > 0) {
      setRevealingIds((prev) => {
        const next = new Set(prev);
        for (const id of newlyDone) next.add(id);
        return next;
      });
      setToastMsg(t("studio.generatedToast"));
    }
  }, [cards, t]);

  /** The Studio root asks for a fresh catalog too (A); the refresher throttles it. */
  useEffect(() => {
    void refreshDirectModels();
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 110)}px`;
  }, [prompt]);

  const catalog = connection?.models ?? [];
  const activeModel = useMemo(() => {
    if (chosenModelId) {
      const explicit = catalog.find((m) => m.id === chosenModelId);
      if (explicit && isImageModel(explicit)) return explicit;
    }
    return resolveStudioModel(
      catalog,
      connection?.defaultImageModelId,
      connection?.lastImageModelId,
    );
  }, [catalog, chosenModelId, connection?.defaultImageModelId, connection?.lastImageModelId]);

  const liveGeneratingCard = useMemo(
    () => cards.find((card) => card.status === "generating") ?? null,
    [cards],
  );

  const formatDayHeading = useCallback(
    (day: StudioDayKey): string => {
      if (day.kind === "today") return t("studio.day.today");
      if (day.kind === "yesterday") return t("studio.day.yesterday");
      const date = new Date(Date.UTC(day.year, day.month - 1, day.day));
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    },
    [t],
  );

  const handleGenerate = async () => {
    const refusal = studioSubmitRefusal({
      sending,
      generating: liveGeneratingCard !== null,
      hasImageModel: activeModel !== null && isImageModel(activeModel),
      prompt,
    });
    // One send at a time: the submit button turns into Stop while a generation
    // runs, and a second click must not create another conversation and bill
    // another request.
    if (refusal === "busy") return;
    if (!connection || !connectedScope) {
      onConnect();
      return;
    }
    if (refusal === "no-model") {
      setToastMsg(t("imageGen.noImageModel"));
      setModelsOpen(true);
      return;
    }
    if (refusal === "empty" || !activeModel) {
      setToastMsg(t("studio.emptyPrompt"));
      return;
    }
    const trimmed = prompt.trim();
    setSending(true);
    setNotice(null);
    const key = await createDirectChatSecret(secureStore()).read();
    if (!key) {
      setSending(false);
      setNotice(t("directChat.failure.unauthorized"));
      return;
    }

    const convId = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const saved = await history.beginTurn({
      conversationId: null,
      scope: connectedScope,
      text: trimmed,
      operation: "image-generation",
      imageModel: true,
      modelId: activeModel.id,
      modelLabel: activeModel.id,
      protocol: IMAGE_PROTOCOL,
      now: new Date().toISOString(),
      newConversationId: convId,
      newMessageId: `msg-${createRequestId()}`,
      newAttemptId: `att-${createIdempotencyKey()}`,
    });
    if (!saved.ok) {
      setSending(false);
      if (saved.reason === "busy") setToastMsg(t("directChat.busy"));
      else setNotice(t("directChat.saveFailed"));
      return;
    }

    setPrompt("");
    directChatService().rememberImageModel(activeModel.id);
    onConnectionChanged?.();
    notifyDirectChatChanged();

    const started = await runner.start({
      conversationId: saved.conversation.id,
      scope: connectedScope,
      attempt: saved.attempt,
      model: activeModel,
      protocol: IMAGE_PROTOCOL,
      authKey: key,
    });
    setSending(false);
    if (!started.ok) {
      if (started.reason === "foreign-scope") setNotice(t("directChat.foreignScope"));
      else if (started.reason === "busy") setToastMsg(t("directChat.busy"));
    }
    notifyDirectChatChanged();
  };

  const handleRetryCard = async (card: StudioCard) => {
    if (!connection || !connectedScope) {
      onConnect();
      return;
    }
    // The retry re-runs the model that made the picture. Falling back to the
    // model selected now would charge the user for a model they did not choose,
    // so an unavailable model is a refusal with a way out instead.
    const modelForRetry = studioRetryModel(catalog, card.modelId);
    if (!modelForRetry) {
      setToastMsg(t("imageGen.modelUnavailable"));
      setModelsOpen(true);
      return;
    }
    setNotice(null);
    const key = await createDirectChatSecret(secureStore()).read();
    if (!key) {
      setNotice(t("directChat.failure.unauthorized"));
      return;
    }
    const outcome = await runner.retry({
      attempt: card.attempt,
      scope: connectedScope,
      model: modelForRetry,
      protocol: IMAGE_PROTOCOL,
      authKey: key,
    });
    if (!outcome.ok) {
      if (outcome.reason === "foreign-scope") setNotice(t("directChat.foreignScope"));
      else setToastMsg(t("directChat.busy"));
    }
    notifyDirectChatChanged();
  };

  const handleStopCard = async (card: StudioCard) => {
    await runner.stop(card.conversationId);
    setToastMsg(t("studio.stoppedToast"));
    notifyDirectChatChanged();
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      // "Delete this image" removes one generation, not the conversation: an
      // image conversation can hold several, and the older ones must survive.
      // A card without an image is the visible end of a chain of attempts for
      // the same prompt, so it goes with the failures it was hiding; a card with
      // an image is that image's own record and goes alone. A generation still
      // arriving is stopped first, which is what the confirm text promises.
      if (target.status === "generating") await runner.stop(target.conversationId);
      const outcome =
        target.status === "complete"
          ? await history.removeImage(target.conversationId, target.attemptId)
          : await history.removeFailedGeneration(target.conversationId, target.attemptId);
      if (!outcome.ok) {
        if (outcome.reason === "busy") setToastMsg(t("directChat.stopFirst"));
        else setNotice(t("directChat.saveFailed"));
        return;
      }
      if (target.mediaId) releaseMediaUrl(target.mediaId);
      setDeleteTarget(null);
      if (viewerCardId === target.id) setViewerCardId(null);
      notifyDirectChatChanged();
    } finally {
      setDeleting(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (liveGeneratingCard) {
      void handleStopCard(liveGeneratingCard);
      return;
    }
    void handleGenerate();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an IME is composing commits its candidate; it never submits.
    if (
      !submitsOnEnter({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
      })
    ) {
      return;
    }
    event.preventDefault();
    if (!liveGeneratingCard && !sending) {
      void handleGenerate();
    }
  };

  const viewerCard = useMemo(
    () => (viewerCardId ? (cards.find((c) => c.id === viewerCardId) ?? null) : null),
    [cards, viewerCardId],
  );
  const viewerUrl =
    viewerCard?.mediaId ? mediaCache.get(viewerCard.mediaId) : null;

  const hasCards = cards.length > 0;
  const isGenerating = liveGeneratingCard !== null || sending;

  return (
    <Screen aurora>
      <NavBar
        title={t("studio.title")}
        largeTitle
        onAvatarClick={onOpenSettings}
        avatarLabel={t("chats.settings")}
        trailing={
          connection ? (
            <Button
              variant="plain"
              size="icon"
              aria-label={t("modelSheet.titleImage")}
              title={t("modelSheet.titleImage")}
              onClick={() => setModelsOpen(true)}
            >
              <Wand2 className="h-5 w-5 stroke-[1.9]" aria-hidden="true" />
            </Button>
          ) : undefined
        }
      />

      <ScreenContent hasDock={Boolean(connection)}>
        <h1 className="rm-title-large mb-2 pt-1">{t("studio.title")}</h1>

        {connection ? (
          <div className="mb-3">
            <ModelPill
              label={activeModel?.id ?? t("chats.modelUnset")}
              onClick={() => setModelsOpen(true)}
            />
          </div>
        ) : null}

        {!connection && !hasCards ? (
          <EmptyState
            icon={<Router className="h-10 w-10 stroke-[1.7]" aria-hidden="true" />}
            title={gatewayConfigured ? t("chats.connectTitle") : t("studio.unavailableTitle")}
            description={gatewayConfigured ? t("chats.connectHint") : t("directChat.unavailable")}
            action={
              gatewayConfigured ? (
                <Button variant="primary" size="large" onClick={onConnect}>
                  {t("chats.connect")}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {!connection && hasCards ? (
          <div className="mb-3 space-y-2">
            <Callout>{t("chats.offlineBanner")}</Callout>
            {gatewayConfigured ? (
              <Button variant="secondary" size="large" onClick={onConnect}>
                {t("chats.connect")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {connection && !hasCards ? (
          <EmptyState
            icon={<Sparkles className="h-10 w-10 stroke-[1.8]" aria-hidden="true" />}
            title={t("imageGen.empty")}
            description={t("studio.emptyHint")}
          />
        ) : null}

        {hasCards ? (
          <div className="space-y-4 pb-4">
            {dayGroups.map((group) => (
              <section key={group.key}>
                <h2 className="mb-2 px-1 text-[13px] font-semibold text-[var(--rm-text-muted)]">
                  {formatDayHeading(group.day)}
                </h2>
                {/* The cards that are not finished artwork lead the day, full
                    width: a generating spinner and a failure reason both need
                    the room, and half a column left the row half empty (D). */}
                {group.prominent.length > 0 ? (
                  <div className="mb-2.5 flex flex-col gap-2.5">
                    {group.prominent.map((card) => (
                      <StudioArtCard
                        key={card.id}
                        layout="banner"
                        card={card}
                        mediaUrl={card.mediaId ? mediaCache.get(card.mediaId) : null}
                        onOpen={(target) => setViewerCardId(target.id)}
                        onStop={(target) => void handleStopCard(target)}
                        onRetry={(target) => void handleRetryCard(target)}
                        onDelete={(target) => setDeleteTarget(target)}
                      />
                    ))}
                  </div>
                ) : null}

                {group.completed.length > 0 ? (
                  <div className="columns-2 gap-2.5">
                    {group.completed.map((card) => (
                      <StudioArtCard
                        key={card.id}
                        card={card}
                        mediaUrl={card.mediaId ? mediaCache.get(card.mediaId) : null}
                        revealing={revealingIds.has(card.id)}
                        onOpen={(target) => setViewerCardId(target.id)}
                        onStop={(target) => void handleStopCard(target)}
                        onRetry={(target) => void handleRetryCard(target)}
                        onDelete={(target) => setDeleteTarget(target)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </div>
        ) : null}
      </ScreenContent>

      {connection ? (
        <ScreenDock>
          {notice ? (
            <Callout tone="error" className="mb-2 py-2.5 text-[13px]">
              {notice}
            </Callout>
          ) : null}
          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-2 rounded-[26px] border border-[var(--rm-hair)] bg-[var(--rm-glass-strong)] p-1.5 pl-3.5 shadow-[var(--rm-shadow)] backdrop-blur-[22px]"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                if (notice) setNotice(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder={t("imageGen.promptPlaceholder")}
              aria-label={t("imageGen.promptPlaceholder")}
              className="max-h-[110px] min-h-[36px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-[22px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none"
            />
            <button
              type="submit"
              data-streaming={isGenerating ? "true" : "false"}
              aria-label={isGenerating ? t("directChat.stop") : t("imageGen.generate")}
              title={isGenerating ? t("directChat.stop") : t("imageGen.generate")}
              className="rm-send-btn"
            >
              <Sparkles className="rm-send-go h-5 w-5 stroke-[2]" aria-hidden="true" />
              <Square className="rm-send-stop h-4 w-4 fill-current" aria-hidden="true" />
            </button>
          </form>
        </ScreenDock>
      ) : null}

      {connection ? (
        <ModelSheet
          open={modelsOpen}
          mode="image"
          models={connection.models}
          selectedId={activeModel?.id ?? null}
          defaultChatModelId={connection.defaultChatModelId}
          defaultImageModelId={connection.defaultImageModelId}
          onClose={() => setModelsOpen(false)}
          onSetDefault={(model, targetMode) => {
            onConnectionChanged?.();
            setToastMsg(
              t(
                targetMode === "image"
                  ? "modelSheet.defaultToastImage"
                  : "modelSheet.defaultToastChat",
                { model: model.id },
              ),
            );
          }}
          onSelect={(model, pickedMode) => {
            if (pickedMode === "chat") {
              onSwitchToChats?.(model.id);
              return;
            }
            setChosenModelId(model.id);
            directChatService().rememberImageModel(model.id);
            onConnectionChanged?.();
            setNotice(null);
          }}
        />
      ) : null}

      <StudioViewerModal
        card={viewerCard}
        mediaUrl={viewerUrl}
        onClose={() => setViewerCardId(null)}
        onReusePrompt={(reusedPrompt) => {
          setPrompt(reusedPrompt);
          textareaRef.current?.focus();
        }}
        onDelete={(target) => setDeleteTarget(target)}
        onToast={(msg) => setToastMsg(msg)}
      />

      <Sheet
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title={t("studio.deleteImageTitle")}
      >
        <p className="px-1 pb-3 text-[14px] leading-[21px] text-[var(--rm-text-secondary)]">
          {t("studio.deleteImageBody")}
        </p>
        <div className="flex flex-col gap-2">
          <Button
            variant="destructive"
            size="large"
            loading={deleting}
            onClick={() => void handleConfirmDelete()}
          >
            {t("studio.deleteImage")}
          </Button>
          <Button
            variant="secondary"
            size="large"
            disabled={deleting}
            onClick={() => setDeleteTarget(null)}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>

      <Toast
        message={toastMsg}
        visible={toastMsg !== null}
        onDismiss={() => setToastMsg(null)}
      />
    </Screen>
  );
}
