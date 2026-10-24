/**
 * The model picker sheet (ADR mobile-redesign D1, D2, bug B13).
 *
 * Groups the models the gateway allows for the current operation by vendor and
 * surfaces per-model capability chips from `catalog.ts` (`capabilityChips`,
 * `splitDirectModels`, `splitDirectImageModels`), and lets the user star a model
 * as the default for chat or Studio.
 *
 * Chat mode lists only what can hold a conversation; image mode lists only what
 * the gateway declared as image output. A row that cannot do the current
 * operation is not listed at all: this sheet is a list of choices, not the whole
 * catalog.
 */
import { Check, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MinihRouterModel } from "@minih-agent/shared";

import type { ModelCapabilityChip } from "../lib/direct-chat/catalog.js";
import { splitDirectModels } from "../lib/direct-chat/catalog.js";
import {
  buildPickerView,
  vendorBadge,
  type PickerMode,
  type PickerModelRow,
} from "../lib/direct-chat/model-picker.js";
import { directChatService, notifyDirectChatChanged, refreshDirectModels } from "../lib/runtime.js";
import { Sheet } from "./ui/Sheet.js";
import { Tag } from "./ui/StatusDot.js";

export type ModelSheetProps = {
  open: boolean;
  models: readonly MinihRouterModel[];
  /** The model the conversation, Studio, or setting is currently on. */
  selectedId: string | null;
  mode?: PickerMode;
  title?: string;
  allowSetDefault?: boolean;
  defaultChatModelId?: string | null;
  defaultImageModelId?: string | null;
  onClose: () => void;
  onSelect: (model: MinihRouterModel, mode: PickerMode) => void;
  onSelectDefault?: (model: MinihRouterModel) => void;
  onSetDefault?: (model: MinihRouterModel, mode: PickerMode) => void;
};

export function ModelSheet({
  open,
  models,
  selectedId,
  mode = "chat",
  title,
  defaultChatModelId,
  defaultImageModelId,
  onClose,
  onSelect,
  onSelectDefault,
  onSetDefault,
}: ModelSheetProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeMode, setActiveMode] = useState<PickerMode>(mode);
  const [localDefaultChat, setLocalDefaultChat] = useState<string | null>(null);
  const [localDefaultImage, setLocalDefaultImage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    /*
     * Opening the picker is one of the moments the catalog may have changed: a
     * model the gateway withdrew must not stay selectable (A). The throttle in
     * `refreshDirectModels` is what keeps this from being a request per open.
     */
    void refreshDirectModels();
    setActiveMode(mode);
    setQuery("");
    const conn = directChatService().connection();
    setLocalDefaultChat(defaultChatModelId ?? conn?.defaultChatModelId ?? null);
    setLocalDefaultImage(defaultImageModelId ?? conn?.defaultImageModelId ?? null);
  }, [open, mode, defaultChatModelId, defaultImageModelId]);

  const view = useMemo(
    () => buildPickerView(models, activeMode, query, t("sessions.otherGroup")),
    [models, activeMode, query, t],
  );

  const activeDefaultId = activeMode === "image" ? localDefaultImage : localDefaultChat;
  const sheetTitle =
    title ?? (activeMode === "image" ? t("modelSheet.titleImage") : t("modelSheet.title"));

  const handleStar = (model: MinihRouterModel) => {
    if (activeMode === "image") {
      directChatService().setDefaultImageModel(model.id);
      setLocalDefaultImage(model.id);
    } else {
      directChatService().setDefaultChatModel(model.id);
      setLocalDefaultChat(model.id);
    }
    if (activeMode === mode) {
      onSelectDefault?.(model);
    }
    onSetDefault?.(model, activeMode);
    notifyDirectChatChanged();
  };

  const renderChip = (chip: ModelCapabilityChip) => {
    if (chip === "image") {
      return (
        <Tag key={chip} tone="gradient">
          {t("modelSheet.cap.image")}
        </Tag>
      );
    }
    if (chip === "vision") {
      return <Tag key={chip}>{t("modelSheet.cap.vision")}</Tag>;
    }
    return <Tag key={chip}>{t("modelSheet.cap.chat")}</Tag>;
  };

  const renderRow = (row: PickerModelRow, subtitleNote?: string) => {
    const { model, chips, contextBadge, priceText } = row;
    const selected = model.id === selectedId;
    const isDefault = model.id === activeDefaultId;
    const badge = vendorBadge(model.vendor, model.id);

    return (
      <div
        key={model.id}
        className="flex items-center gap-1 rounded-[14px] pr-1 transition-colors hover:bg-[var(--rm-bg-surface-2)]"
      >
        <button
          type="button"
          onClick={() => {
            onSelect(model, activeMode);
            onClose();
          }}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-1 pr-2 text-left transition-transform duration-150 active:scale-[0.985]"
        >
          <span
            aria-hidden="true"
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-[11px] text-[13px] font-extrabold text-white ${badge.gradientClass}`}
          >
            {badge.monogram}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[16px] font-semibold leading-[21px] text-[var(--rm-text-primary)]">
              {model.id}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {chips.map(renderChip)}
              {contextBadge ? <Tag>{contextBadge}</Tag> : null}
            </span>
            {subtitleNote ? (
              <span className="mt-1 block text-[12px] leading-[16px] text-[var(--rm-text-muted)]">
                {subtitleNote}
              </span>
            ) : priceText ? (
              <span className="mt-1 block text-[11px] leading-[15px] text-[var(--rm-text-faint)]">
                {priceText}
              </span>
            ) : null}
          </span>
          {selected ? (
            <span
              aria-hidden="true"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[image:var(--rm-aurora)] text-white"
            >
              <Check className="h-3.5 w-3.5 stroke-[3]" />
            </span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            handleStar(model);
          }}
          aria-label={t("modelSheet.setDefault")}
          aria-pressed={isDefault}
          title={t("modelSheet.setDefault")}
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] transition-transform duration-200 ease-[var(--rm-ease-spring)] active:scale-125 ${
            isDefault ? "text-[#facc15]" : "text-[var(--rm-text-faint)]"
          }`}
        >
          <Star
            className="h-5 w-5"
            fill={isDefault ? "currentColor" : "none"}
            strokeWidth={1.9}
            aria-hidden="true"
          />
        </button>
      </div>
    );
  };

  const hasAnyUsable = view.vendorGroups.length > 0;
  /**
   * Whether the gateway has simply not opened any model to mobile chat.
   *
   * Only that gets the "turn it on in the gateway" copy: a catalog whose rows
   * are all image models, or a search that matches nothing, keeps the wording
   * it had. Without the distinction the reader would go looking for a switch
   * that is not the problem.
   */
  const strictMobileEmpty =
    activeMode === "chat" &&
    query.trim() === "" &&
    models.length > 0 &&
    !hasAnyUsable &&
    splitDirectModels(models).disabled.some((row) => row.reason === "not-enabled-for-mobile");

  return (
    <Sheet open={open} onClose={onClose} title={sheetTitle}>
      {/* Chat / Image segmented control */}
      <div className=" relative flex w-full rounded-[12px] bg-[var(--rm-bg-surface-2)] p-[3px]">
        <span
          aria-hidden="true"
          className="rm-seg-slider pointer-events-none"
          style={{
            width: "calc((100% - 6px) / 2)",
            transform: `translateX(${activeMode === "image" ? 100 : 0}%)`,
          }}
        />
        <button
          type="button"
          onClick={() => setActiveMode("chat")}
          aria-pressed={activeMode === "chat"}
          className={`relative z-10 h-[34px] flex-1 text-[14px] font-semibold transition-colors ${
            activeMode === "chat"
              ? "text-[var(--rm-text-primary)]"
              : "text-[var(--rm-text-muted)]"
          }`}
        >
          {t("modelSheet.tabChat")}
        </button>
        <button
          type="button"
          onClick={() => setActiveMode("image")}
          aria-pressed={activeMode === "image"}
          className={`relative z-10 h-[34px] flex-1 text-[14px] font-semibold transition-colors ${
            activeMode === "image"
              ? "text-[var(--rm-text-primary)]"
              : "text-[var(--rm-text-muted)]"
          }`}
        >
          {t("modelSheet.tabImage")}
        </button>
      </div>

      {/* Search */}
      <label className="flex min-h-[42px] items-center gap-2 rounded-[14px] bg-[var(--rm-bg-surface-2)] px-3.5">
        <Search className="h-[18px] w-[18px] shrink-0 text-[var(--rm-text-muted)]" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("modelSheet.search")}
          aria-label={t("modelSheet.search")}
          className="min-w-0 flex-1 bg-transparent py-2 text-[16px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none"
        />
      </label>

      <p className="px-1 text-[12px] leading-[18px] text-[var(--rm-text-muted)]">
        {t("modelSheet.starHint")}
      </p>

      <div className="max-h-[52dvh] overflow-y-auto overscroll-contain pr-0.5">
        {!hasAnyUsable ? (
          <p className="px-1 py-6 text-center text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
            {models.length === 0
              ? t("modelSheet.empty")
              : strictMobileEmpty
                ? // A strict switch, and nobody opened a model: the gateway is
                  // where this is fixed, so the copy says so.
                  t("modelSheet.noMobileChatModels")
                : activeMode === "image" && query.trim() === ""
                  ? // Nothing declared for images: the gateway decides this, so the
                    // copy says where to fix it instead of blaming the search.
                    t("modelSheet.noImageModels")
                  : t("modelSheet.noMatch")}
          </p>
        ) : (
          <div className="space-y-3">
            {view.vendorGroups.map((group) => (
              <div key={group.vendor}>
                <div className="mb-1 mt-2 px-1 text-[12px] font-bold tracking-[0.04em] text-[var(--rm-text-muted)]">
                  {group.vendor}
                </div>
                <div className="divide-y divide-[var(--rm-hair)]">
                  {group.rows.map((row) => renderRow(row))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
