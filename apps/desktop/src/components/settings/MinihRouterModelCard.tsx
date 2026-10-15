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
  const context = formatContextTokens(model.contextWindow);
  const cache = cachePriceText(model.price, locale, t);
  const meta = [
    context ? t("settings.minihRouterContext", { tokens: context }) : null,
    cache,
    model.tieredPricing ? t("settings.minihRouterTiered") : null,
  ].filter((entry): entry is string => Boolean(entry));
  const from = model.multiplePrices ? (
    <span className="minih-router-price-from">{t("settings.minihRouterPriceFrom")}</span>
  ) : null;

  const copy = () => {
    void navigator.clipboard.writeText(model.id).then(
      () => showToast(t("settings.minihRouterCopied"), { variant: "success" }),
      (error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
  };

  return (
    <li className="minih-router-model" data-model-id={model.id}>
      <div className="minih-router-model-top">
        <span className="minih-router-model-vendor">{model.vendor}</span>
        <span className="minih-router-model-tags">
          {selectable ? (
            <input
              type="checkbox"
              className="minih-router-model-check"
              checked={selected}
              disabled={busy}
              aria-label={t("settings.minihRouterSelectModel", { model: model.id })}
              onChange={() => onToggle?.(model)}
            />
          ) : null}
          {configured ? <Badge tone="success">{t("settings.minihRouterInUse")}</Badge> : null}
          <Badge>{t(CATEGORY_KEYS[model.category])}</Badge>
        </span>
      </div>
      <div className="minih-router-model-name">
        <code title={model.id}>{model.id}</code>
        <button
          type="button"
          className="minih-router-copy"
          aria-label={t("settings.minihRouterCopyModel")}
          title={t("settings.minihRouterCopyModel")}
          onClick={copy}
        >
          <IconCopy size={12} />
        </button>
      </div>
      {unpricedLabel ? <div className="minih-router-model-meta">{unpricedLabel}</div> : null}
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
      {meta.length > 0 ? <div className="minih-router-model-meta">{meta.join(" · ")}</div> : null}
    </li>
  );
}
