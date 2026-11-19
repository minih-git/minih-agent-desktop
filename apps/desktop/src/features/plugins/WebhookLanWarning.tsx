import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginSummary } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";

export function WebhookLanWarning({ plugins }: { plugins: readonly PluginSummary[] }) {
  const { t } = useTranslation();
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pluginIds = plugins.filter((plugin) => plugin.enabled && plugin.permissions.includes("inbound.webhook")).map((plugin) => plugin.id).sort().join("\0");

  useEffect(() => {
    const current = ++generation.current;
    setListening(false);
    setError(null);
    if (!pluginIds) return () => { generation.current += 1; };
    setBusy(false);
    void Promise.all(pluginIds.split("\0").map((id) => api.listPluginWebhooks(id))).then(
      (statuses) => {
        if (generation.current === current) setListening(statuses.some((status) => !status.loopbackOnly && status.receivers.some((receiver) => receiver.enabled)));
      },
      () => { if (generation.current === current) setError(t("plugins.webhook.loadFailed")); },
    );
    return () => { generation.current += 1; };
  }, [pluginIds, plugins, t]);

  const localOnly = async () => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await api.setWebhookLoopbackOnly(true);
      if (generation.current === current) setListening(false);
    } catch {
      if (generation.current === current) setError(t("plugins.webhook.localOnlyFailed"));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  if (!listening && !error) return null;
  return (
    <section className="plugins-callout" aria-label={t("plugins.webhook.title")}>
      <div>
        {listening ? <p className="plugins-callout-body">{t("plugins.webhook.lanWarning")}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {listening ? <Button type="button" disabled={busy} onClick={() => void localOnly()}>{t("plugins.webhook.localOnly")}</Button> : null}
      </div>
    </section>
  );
}
