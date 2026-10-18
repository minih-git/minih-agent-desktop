/**
 * One gateway model card, shared by the accounts panel's plaza, the models
 * page's chosen grid and the add-models dialog — one card design, three homes.
 */
import { useTranslation } from "react-i18next";
import type { MinihRouterModel } from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { Badge } from "../ui";
import { IconCopy } from "../icons";
import {
  cachePriceText,
  formatContextTokens,
  modelVendorLabel,
  priceCell,
} from "./minih-router-format";

const CATEGORY_KEYS: Record<MinihRouterModel["category"], string> = {
  chat: "settings.minihRouterCategoryChat",
  vision: "settings.minihRouterCategoryVision",
  video: "settings.minihRouterCategoryVideo",
  embedding: "settings.minihRouterCategoryEmbedding",
  code: "settings.minihRouterCategoryCode",
};

export type MinihRouterModelCardProps = {
  model: MinihRouterModel;
  locale: string;
  configured?: boolean;
  /** Shown instead of the price pair when the gateway prices nothing for it. */
  unpricedLabel?: string;
  /** Selectable cards carry the dialog's checkbox instead of the status badge. */
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (model: MinihRouterModel) => void;
  /** Disables the checkbox while the caller saves. */
  busy?: boolean;
};

export function MinihRouterModelCard({
  model,
  locale,
  configured,
  unpricedLabel,
  selectable,
  selected = false,
  onToggle,
  busy,
}: MinihRouterModelCardProps) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const vendorLabel = modelVendorLabel(model, t("settings.minihRouterVendorOther"));
  const context = formatContextTokens(model.contextWindow);
  const cache = cachePriceText(model.price, locale, t);
  const metaItems = [
    context ? t("settings.minihRouterContext", { tokens: context }) : null,
    model.tieredPricing ? t("settings.minihRouterTiered") : null,
    cache,
    unpricedLabel ?? null,
  ].filter((entry): entry is string => Boolean(entry));
  const from = model.multiplePrices ? (
    <span className="minih-router-price-from">{t("settings.minihRouterPriceFrom")}</span>
  ) : null;

  const canToggle = Boolean(selectable && !configured && !busy);

  const copy = () => {
    void navigator.clipboard.writeText(model.id).then(
      () => showToast(t("settings.minihRouterCopied"), { variant: "success" }),
      (error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
  };

  const cardClasses = [
    "minih-router-model",
    selectable ? "is-selectable" : "",
    selected && !configured ? "is-selected" : "",
    configured ? "is-configured" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className={cardClasses}
      data-model-id={model.id}
      data-model-vendor={vendorLabel}
      onClick={(event) => {
        if (!canToggle) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, input, a")) return;
        onToggle?.(model);
      }}
    >
      <div className="minih-router-model-top">
        <span className="minih-router-model-vendor" title={vendorLabel}>
          {vendorLabel}
        </span>
        <span className="minih-router-model-tags">
          {configured ? <Badge tone="success">{t("settings.minihRouterInUse")}</Badge> : null}
          <Badge>{t(CATEGORY_KEYS[model.category])}</Badge>
          {selectable ? (
            <input
              type="checkbox"
              className="minih-router-model-check"
              checked={selected}
              disabled={busy || configured}
              aria-label={t("settings.minihRouterSelectModel", { model: model.id })}
              onChange={() => onToggle?.(model)}
            />
          ) : null}
        </span>
      </div>
      <div className="minih-router-model-name">
        <code title={model.id}>{model.id}</code>
        <button
          type="button"
          className="minih-router-copy"
          aria-label={t("settings.minihRouterCopyModel")}
          title={t("settings.minihRouterCopyModel")}
          onClick={(event) => {
            event.stopPropagation();
            copy();
          }}
        >
          <IconCopy size={12} />
        </button>
      </div>
      <dl className="minih-router-model-prices">
        <div>
          <dt>{t("settings.minihRouterInputPrice")}</dt>
          <dd>
            {priceCell(model.price.input, locale, t)}
            {model.price.input !== null ? from : null}
          </dd>
        </div>
        <div>
          <dt>{t("settings.minihRouterOutputPrice")}</dt>
          <dd>
            {priceCell(model.price.output, locale, t)}
            {model.price.output !== null ? from : null}
          </dd>
        </div>
      </dl>
      <div
        className={
          metaItems.length > 0 ? "minih-router-model-meta" : "minih-router-model-meta is-empty"
        }
      >
        {metaItems.length > 0
          ? metaItems.map((item, index) => (
              <span key={index} className="minih-router-meta-tag">
                {item}
              </span>
            ))
          : null}
      </div>
    </li>
  );
}
