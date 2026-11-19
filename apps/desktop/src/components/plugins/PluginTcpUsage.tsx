import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { formatBytes } from "../../features/plugins/model";

type Usage = Awaited<ReturnType<typeof api.getPluginTcpUsage>>;

/** Daily counters are host-owned; the plugin never sees other plugins' traffic. */
export function PluginTcpUsage({ pluginId }: { pluginId: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setUsage(null);
    setError(null);
    void api.getPluginTcpUsage(pluginId).then(
      (result) => { if (active) setUsage(result); },
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { active = false; };
  }, [pluginId]);
  return <PluginTcpUsageContent usage={usage} error={error} />;
}

export function PluginTcpUsageContent({ usage, error }: { usage: Usage | null; error: string | null }) {
  const { t } = useTranslation();

  const size = (bytes: number) => bytes === 0 ? "0 B" : formatBytes(bytes);
  return (
    <section className="plugins-setting-row" aria-label={t("plugins.tcpUsage")}>
      <div className="plugins-setting-copy">
        <div className="plugins-setting-title">{t("plugins.tcpUsage")}</div>
        {error ? <p role="alert">{t("plugins.tcpUsageError", { reason: error })}</p> : null}
        {!error && !usage ? <p>{t("plugins.tcpUsageLoading")}</p> : null}
        {usage && usage.last7Days.endpoints.length === 0 ? <p>{t("plugins.tcpUsageEmpty")}</p> : null}
        {usage?.last7Days.endpoints.map((endpoint) => {
          const today = usage.today.endpoints.find((row) => row.host === endpoint.host && row.port === endpoint.port);
          return (
            <div key={`${endpoint.host}:${endpoint.port}`}>
              <strong>{endpoint.host}:{endpoint.port}</strong>
              <div>{t("plugins.tcpUsageToday")} · {t("plugins.tcpUsageReceived")} {size(today?.bytesIn ?? 0)} · {t("plugins.tcpUsageSent")} {size(today?.bytesOut ?? 0)}</div>
              <div>{t("plugins.tcpUsageWeek")} · {t("plugins.tcpUsageReceived")} {size(endpoint.bytesIn)} · {t("plugins.tcpUsageSent")} {size(endpoint.bytesOut)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
