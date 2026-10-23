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
import { isImageModel, resolveStudioModel } from "../lib/direct-chat/catalog.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import type { DirectChatTranscript } from "../lib/direct-chat/history-store.js";
import { createMediaUrl } from "../lib/direct-chat/media.js";
import { createDirectChatSecret } from "../lib/direct-chat/secret.js";
import {
  groupByDay,
  studioCards,
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

  const urlCacheRef = useRef<Map<string, string>>(new Map());
  const prevGeneratingIdsRef = useRef<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Drop one cached object URL. Deleting an image must not leave its blob pinned
   * for the life of the page.
   */
  const releaseMediaUrl = useCallback((mediaId: string) => {
    const url = urlCacheRef.current.get(mediaId);
    if (!url) return;
    urlCacheRef.current.delete(mediaId);
    URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const scope = connectedScope ?? (await history.lastScope());
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
        for (const media of tr.media ?? []) {
          if (!urlCacheRef.current.has(media.id)) {
            urlCacheRef.current.set(media.id, createMediaUrl(media));
          }
        }
      }
      setTranscripts(valid);
    };
    void load();
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, connectedScope]);

  const cards = useMemo(() => studioCards(transcripts), [transcripts]);
  const dayGroups = useMemo(() => groupByDay(cards), [cards]);

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
    if (!connection || !connectedScope) {
      onConnect();
      return;
    }
    if (!activeModel || !isImageModel(activeModel)) {
      setNotice(t("imageGen.noImageModel"));
      setModelsOpen(true);
      return;
    }
    const trimmed = prompt.trim();
    if (!trimmed) {
      setNotice(t("studio.emptyPrompt"));
      return;
    }
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
      setNotice(saved.reason === "busy" ? t("directChat.busy") : t("directChat.saveFailed"));
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
      setNotice(
        started.reason === "busy"
          ? t("directChat.busy")
          : started.reason === "foreign-scope"
            ? t("directChat.foreignScope")
            : null,
      );
    }
    notifyDirectChatChanged();
  };

  const handleRetryCard = async (card: StudioCard) => {
    if (!connection || !connectedScope) {
      onConnect();
      return;
    }
    const modelForRetry =
      catalog.find((m) => m.id === card.modelId && isImageModel(m)) ?? activeModel;
    if (!modelForRetry || !isImageModel(modelForRetry)) {
      setNotice(t("imageGen.modelUnavailable"));
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
      setNotice(
        outcome.reason === "foreign-scope" ? t("directChat.foreignScope") : t("directChat.busy"),
      );
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
      // A generation still arriving is stopped first, which is what the confirm
      // text promises.
      if (target.status === "generating") await runner.stop(target.conversationId);
      const outcome = await history.removeImage(target.conversationId, target.attemptId);
      if (!outcome.ok) {
        setNotice(
          outcome.reason === "busy" ? t("directChat.stopFirst") : t("directChat.saveFailed"),
        );
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!liveGeneratingCard && !sending) {
        void handleGenerate();
      }
    }
  };

  const viewerCard = useMemo(
    () => (viewerCardId ? (cards.find((c) => c.id === viewerCardId) ?? null) : null),
    [cards, viewerCardId],
  );
  const viewerUrl =
    viewerCard?.mediaId ? (urlCacheRef.current.get(viewerCard.mediaId) ?? null) : null;

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
                <div className="columns-2 gap-2.5">
                  {group.cards.map((card) => (
                    <StudioArtCard
                      key={card.id}
                      card={card}
                      mediaUrl={
                        card.mediaId ? (urlCacheRef.current.get(card.mediaId) ?? null) : null
                      }
                      revealing={revealingIds.has(card.id)}
                      onOpen={(target) => setViewerCardId(target.id)}
                      onStop={(target) => void handleStopCard(target)}
                      onRetry={(target) => void handleRetryCard(target)}
                      onDelete={(target) => setDeleteTarget(target)}
                    />
                  ))}
                </div>
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
            {t("directChat.delete")}
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
