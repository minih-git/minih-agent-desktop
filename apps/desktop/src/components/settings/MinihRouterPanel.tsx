/**
 * Minih Router on the model configuration page: the token's balance, and
 * below it the gateway's model plaza with prices, one page at a time.
 *
 * The panel belongs to a saved `minih-router` row with a stored token. All
 * reads go through Electron main, which holds the token; this component only
 * renders what main parsed. Refresh re-reads both halves.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  minihRouterHeadlineQuota,
  type MinihRouterAccount,
  type MinihRouterModel,
  type ProviderPublic,
} from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, Input } from "../ui";
import { IconChevronLeft, IconChevronRight, IconCopy, IconRefresh, IconSearch } from "../icons";
import { endpointLabel } from "./service-catalog";
import {
  cachePriceText,
  formatContextTokens,
  formatUsd,
  isModelConfigured,
  priceCell,
  quotaLabel,
  quotaRemainingShare,
} from "./minih-router-format";
import {
  useMinihRouterAccount,
  useMinihRouterModels,
  useMinihRouterSelectedModels,
} from "./useMinihRouter";

export const MINIH_ROUTER_MODEL_PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

const CATEGORY_KEYS: Record<MinihRouterModel["category"], string> = {
  chat: "settings.minihRouterCategoryChat",
  vision: "settings.minihRouterCategoryVision",
  video: "settings.minihRouterCategoryVideo",
  embedding: "settings.minihRouterCategoryEmbedding",
  code: "settings.minihRouterCategoryCode",
};

export type MinihRouterPanelProps = {
  provider: ProviderPublic;
};

export function MinihRouterPanel({ provider }: MinihRouterPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const headingId = useId();
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  // A typed search settles before it is sent, and always starts on page one.
  useEffect(() => {
    if (search === query) return;
    const timer = window.setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  const account = useMinihRouterAccount(provider.id, revision);
  // The row's own choices, in the row's own order: the panel leads with what
  // this service sends, then shows what else the gateway would price.
  const chosenIds = useMemo(
    () => provider.models.map((model) => model.id),
    [provider.models],
  );
  const selected = useMinihRouterSelectedModels(provider, chosenIds, revision);
  const models = useMinihRouterModels(
    provider.id,
    { page, pageSize: MINIH_ROUTER_MODEL_PAGE_SIZE, query },
    revision,
  );
  const refreshing =
    account.state === "loading" || models.state === "loading" || selected.state === "loading";

  return (
    <section className="settings-card-block minih-router-panel" aria-labelledby={headingId}>
      <div className="minih-router-head">
        <div className="minih-router-head-copy">
          <h3 id={headingId} className="settings-card-heading">{provider.name}</h3>
          <span className="minih-router-head-detail">
            {t("settings.minihRouterPanelDesc")}
            {provider.baseUrl ? ` · ${endpointLabel(provider.baseUrl)}` : ""}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshing}
          onClick={() => setRevision((value) => value + 1)}
        >
          <span className="model-config-btn-inner">
            <IconRefresh size={13} />
            <span>{t("settings.minihRouterRefresh")}</span>
          </span>
        </Button>
      </div>

      <div className="settings-panel minih-router-body">
        <AccountSummary account={account.data} locale={locale} />
        {account.state === "loading" && !account.data ? (
          <p className="minih-router-status">{t("settings.minihRouterLoading")}</p>
        ) : null}
        {account.state === "error" ? (
          <p className="minih-router-status is-error" role="alert">
            <span>{t("settings.minihRouterAccountFailed")}</span>
            <span className="minih-router-status-detail">{account.message}</span>
          </p>
        ) : null}

        <div className="minih-router-models">
          <div className="minih-router-models-head">
            <h4 className="minih-router-models-title">{t("settings.minihRouterSelectedModels")}</h4>
          </div>
          <p className="minih-router-price-hint">{t("settings.minihRouterSelectedHint")}</p>
          {chosenIds.length === 0 ? (
            <p className="minih-router-status">{t("settings.minihRouterSelectedNone")}</p>
          ) : null}
          {chosenIds.length > 0 && selected.data.length === 0 ? (
            <p className="minih-router-status">{t("settings.minihRouterLoading")}</p>
          ) : null}
          {selected.state === "error" ? (
            <p className="minih-router-status is-error" role="alert">
              <span className="minih-router-status-detail">{selected.message}</span>
            </p>
          ) : null}
          <ul
            className="minih-router-model-grid"
            data-model-section="chosen"
            hidden={selected.data.length === 0}
          >
            {selected.data.map((model) => (
              <ModelCard
                key={model.model.id}
                model={model.model}
                locale={locale}
                configured
                unpricedLabel={model.priced ? undefined : t("settings.minihRouterSelectedUnpriced")}
              />
            ))}
          </ul>

          <div className="minih-router-models-head">
            <h4 className="minih-router-models-title">{t("settings.minihRouterAllModels")}</h4>
            <div className="minih-router-search">
              <IconSearch size={13} aria-hidden />
              <Input
                value={search}
                placeholder={t("settings.minihRouterSearchModels")}
                aria-label={t("settings.minihRouterSearchModels")}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <p className="minih-router-price-hint">{t("settings.minihRouterPriceHint")}</p>

          {models.state === "error" ? (
            <div className="minih-router-status is-error" role="alert">
              <span>{t("settings.minihRouterModelsFailed")}</span>
              <span className="minih-router-status-detail">{models.message}</span>
              <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
                {t("settings.minihRouterRetry")}
              </Button>
            </div>
          ) : null}
          {models.data === null && models.state === "loading" ? (
            <p className="minih-router-status">{t("settings.minihRouterLoading")}</p>
          ) : null}
          {models.data && models.data.items.length === 0 ? (
            <p className="minih-router-status">{t("settings.minihRouterModelsEmpty")}</p>
          ) : null}
          {models.data && models.data.items.length > 0 ? (
            <ul
              className="minih-router-model-grid"
              data-model-section="plaza"
              aria-busy={models.state === "loading" ? "true" : undefined}
            >
              {models.data.items.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  locale={locale}
                  configured={isModelConfigured(model.id, provider.models)}
                />
              ))}
            </ul>
          ) : null}

          {models.data && models.data.totalPages > 1 ? (
            <nav className="minih-router-pagination" aria-label={t("settings.minihRouterModels")}>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("settings.minihRouterPrevPage")}
                disabled={page <= 1 || models.state === "loading"}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <IconChevronLeft size={14} />
              </Button>
              <span className="minih-router-page-status">
                {t("settings.minihRouterPageStatus", {
                  page: models.data.page,
                  pages: models.data.totalPages,
                  total: models.data.totalItems,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("settings.minihRouterNextPage")}
                disabled={page >= models.data.totalPages || models.state === "loading"}
                onClick={() => setPage((value) => value + 1)}
              >
                <IconChevronRight size={14} />
              </Button>
            </nav>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AccountSummary({
  account,
  locale,
}: {
  account: MinihRouterAccount | null;
  locale: string;
}) {
  const { t } = useTranslation();
  if (!account) return null;
  const headline = minihRouterHeadlineQuota(account.quotas);
  const formatTime = (ms: number) => new Date(ms).toLocaleString(locale);
  const expires = account.expired
    ? t("settings.minihRouterExpired")
    : account.expiresAtMs
      ? formatTime(account.expiresAtMs)
      : t("settings.minihRouterNeverExpires");
  const otherQuotas = account.quotas.length > 1 ? account.quotas : [];
  return (
    <>
      <dl className="minih-router-stats">
        <div className="minih-router-stat is-balance">
          <dt>{t("settings.minihRouterBalance")}</dt>
          <dd>
            <span className="minih-router-stat-value">
              {headline ? formatUsd(headline.remainingUsd, locale) : t("settings.minihRouterUnlimited")}
            </span>
            {headline ? (
              <span className="minih-router-stat-detail">
                {quotaLabel(headline, t)} ·{" "}
                {t("settings.minihRouterBalanceOf", { limit: formatUsd(headline.limitUsd, locale) })}
              </span>
            ) : null}
            {headline ? (
              <span className="minih-router-meter" aria-hidden>
                <span style={{ width: `${Math.round(quotaRemainingShare(headline) * 100)}%` }} />
              </span>
            ) : null}
          </dd>
        </div>
        {account.usage ? (
          <>
            <div className="minih-router-stat">
              <dt>{t("settings.minihRouterSpent", { days: account.usage.days })}</dt>
              <dd>
                <span className="minih-router-stat-value">
                  {formatUsd(account.usage.costUsd, locale)}
                </span>
              </dd>
            </div>
            <div className="minih-router-stat">
              <dt>{t("settings.minihRouterRequests", { days: account.usage.days })}</dt>
              <dd>
                <span className="minih-router-stat-value">
                  {new Intl.NumberFormat(locale).format(account.usage.requestCount)}
                </span>
              </dd>
            </div>
          </>
        ) : null}
        <div className="minih-router-stat">
          <dt>{t("settings.minihRouterExpires")}</dt>
          <dd>
            <span className="minih-router-stat-value is-compact">{expires}</span>
            {account.keyName || account.maskedKey ? (
              <span className="minih-router-stat-detail">
                {[account.keyName, account.maskedKey].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {!account.allowed ? (
        <p className="minih-router-status is-error" role="alert">
          {account.nextAvailableAtMs
            ? t("settings.minihRouterBlocked", { time: formatTime(account.nextAvailableAtMs) })
            : t("settings.minihRouterBlockedNoReset")}
        </p>
      ) : null}

      {otherQuotas.length > 0 ? (
        <ul className="minih-router-quotas">
          {otherQuotas.map((quota) => (
            <li key={quota.id} className="minih-router-quota">
              <span className="minih-router-quota-label">{quotaLabel(quota, t)}</span>
              <span className="minih-router-quota-value">
                {t("settings.minihRouterQuotaUsage", {
                  remaining: formatUsd(quota.remainingUsd, locale),
                  limit: formatUsd(quota.limitUsd, locale),
                })}
              </span>
              {quota.windowEndsAtMs ? (
                <span className="minih-router-quota-reset">
                  {t("settings.minihRouterQuotaResets", { time: formatTime(quota.windowEndsAtMs) })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {Number(account.priceMultiplier) !== 1 ? (
        <p className="minih-router-price-hint">
          {t("settings.minihRouterMultiplier", { multiplier: account.priceMultiplier })}
        </p>
      ) : null}
    </>
  );
}

function ModelCard({
  model,
  locale,
  configured,
  unpricedLabel,
}: {
  model: MinihRouterModel;
  locale: string;
  configured: boolean;
  /** Shown instead of the price pair when the gateway prices nothing for it. */
  unpricedLabel?: string;
}) {
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
