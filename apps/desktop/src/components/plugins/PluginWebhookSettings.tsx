import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { Button, Input } from "../ui";

type Status = { loopbackOnly: boolean; receivers: Array<{ id: string; url: string; enabled: boolean }> };

/** Token values are displayed only by a native system dialog, not this renderer. */
export function PluginWebhookSettings({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setError(null);
    setBusy(false);
    void api.listPluginWebhooks(pluginId).then(
      (value) => { if (generation.current === current) setStatus(value); },
      () => { if (generation.current === current) setError(t("plugins.webhook.loadFailed")); },
    );
    return () => { generation.current += 1; };
  }, [pluginId, t]);

  const changeMode = async () => {
    if (!status || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await api.setWebhookLoopbackOnly(!status.loopbackOnly);
      const next = await api.listPluginWebhooks(pluginId);
      if (generation.current === current) setStatus(next);
    } catch {
      if (generation.current === current) setError(t("plugins.webhook.localOnlyFailed"));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  const openToken = async (webhookId: string) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await api.openWebhookTokenDialog(pluginId, webhookId);
    } catch {
      if (generation.current === current) setError(t("plugins.webhook.tokenActionFailed"));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  if (status && status.receivers.length === 0) return null;
  return (
    <section className="plugins-sheet-section" aria-label={t("plugins.webhook.title")}>
      <h3 className="plugins-sheet-section-title">{t("plugins.webhook.title")}</h3>
      {!status && !error ? <p>{t("plugins.webhook.loading")}</p> : null}
      {status && !status.loopbackOnly ? <p className="plugins-callout-body">{t("plugins.webhook.lanWarning")}</p> : null}
      {status ? (
        <Button type="button" disabled={busy} onClick={() => void changeMode()}>
          {t(status.loopbackOnly ? "plugins.webhook.enableLan" : "plugins.webhook.localOnly")}
        </Button>
      ) : null}
      {status?.receivers.map((receiver) => (
        <div className="plugins-setting-row" key={receiver.id}>
          <div className="plugins-setting-copy">
            <div className="plugins-setting-title">{receiver.id}</div>
            <Input aria-label={`${t("plugins.webhook.title")} ${receiver.id}`} value={receiver.url} readOnly />
            <span>{t("plugins.webhook.tokenMasked")} · <span aria-hidden="true">••••••••</span></span>
          </div>
          <Button type="button" disabled={busy || !receiver.enabled} onClick={() => void openToken(receiver.id)}>
            {t("plugins.webhook.manageToken")}
          </Button>
        </div>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
