/**
 * The Minih Router token's balance, quotas and usage, as the accounts page and
 * any panel that anchors to a saved router row render it. Reads go through
 * Electron main, which holds the token; this component only renders what main
 * parsed.
 */
import { useTranslation } from "react-i18next";
import {
  minihRouterHeadlineQuota,
  type MinihRouterAccount,
} from "@minih-agent/shared";
import { formatUsd, quotaLabel, quotaRemainingShare } from "./minih-router-format";

export type MinihRouterAccountSummaryProps = {
  account: MinihRouterAccount | null;
  locale: string;
};

export function MinihRouterAccountSummary({ account, locale }: MinihRouterAccountSummaryProps) {
  const { t } = useTranslation();
  if (!account) return null;
  const headline = minihRouterHeadlineQuota(account.quotas);
  const formatTime = (ms: number) => new Date(ms).toLocaleString(locale);
  const expires = account.expired
    ? t("settings.minihRouterExpired")
    : account.expiresAtMs
      ? formatTime(account.expiresAtMs)
      : t("settings.minihRouterNeverExpires");
  const otherQuotas =
    account.quotas.length > 1
      ? account.quotas.filter((quota) => quota.id !== headline?.id)
      : [];
  const keyIdentity = [account.keyName, account.maskedKey].filter(Boolean).join(" · ");
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
              <span className="minih-router-meter" aria-hidden>
                <span style={{ width: `${Math.round(quotaRemainingShare(headline) * 100)}%` }} />
              </span>
            ) : null}
            {headline ? (
              <div className="minih-router-balance-foot">
                <span className="minih-router-stat-detail">
                  {quotaLabel(headline, t)} ·{" "}
                  {t("settings.minihRouterBalanceOf", { limit: formatUsd(headline.limitUsd, locale) })}
                </span>
                {headline.windowEndsAtMs ? (
                  <span className="minih-router-stat-reset">
                    {t("settings.minihRouterQuotaResets", { time: formatTime(headline.windowEndsAtMs) })}
                  </span>
                ) : null}
              </div>
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
        <div className="minih-router-stat is-expires">
          <dt>{t("settings.minihRouterExpires")}</dt>
          <dd className="minih-router-expires-body">
            <span className="minih-router-stat-value is-compact">{expires}</span>
            {keyIdentity ? (
              <span className="minih-router-stat-detail is-key-meta">{keyIdentity}</span>
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
              <div className="minih-router-quota-row">
                <span className="minih-router-quota-label">{quotaLabel(quota, t)}</span>
                <span className="minih-router-quota-value">
                  {t("settings.minihRouterQuotaUsage", {
                    remaining: formatUsd(quota.remainingUsd, locale),
                    limit: formatUsd(quota.limitUsd, locale),
                  })}
                </span>
              </div>
              <span className="minih-router-meter is-subtle" aria-hidden>
                <span style={{ width: `${Math.round(quotaRemainingShare(quota) * 100)}%` }} />
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
