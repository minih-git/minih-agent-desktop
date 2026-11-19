import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginScheduleView } from "../../../electron/shared/plugin-schedule";
import { Badge, Button } from "../../components/ui";
import { api } from "../../lib/api";
import "./plugin-schedules.css";

export function PluginSchedulesPanel() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<PluginScheduleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await api.listPluginSchedules();
      if (request === generation.current) { setItems(next); setError(""); }
    } catch (cause) {
      if (request === generation.current) setError(t("plugins.schedules.loadError", { error: String(cause) }));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    void load();
    const unsubscribe = api.onPluginChanged(() => void load());
    return () => { generation.current++; unsubscribe(); };
  }, [load]);
  const act = async (item: PluginScheduleView, action: "pause" | "run") => {
    const id = `${item.pluginId}/${item.scheduleId}`;
    setBusy(id);
    try {
      if (action === "pause") await api.pausePluginSchedule(item.pluginId, item.scheduleId, !item.paused);
      else await api.runPluginSchedule(item.pluginId, item.scheduleId);
      await load();
    } catch (cause) {
      setError(t(action === "run" ? "plugins.schedules.runError" : "plugins.schedules.pauseError", { error: String(cause) }));
    } finally { setBusy(""); }
  };
  const date = (value: number | null) => value === null ? t("plugins.schedules.none") : new Date(value).toLocaleString(i18n.language);
  return (
    <section id="plugins-panel-schedules" role="tabpanel" aria-labelledby="plugins-tab-schedules" className="plugin-schedules">
      {error ? <p className="plugin-schedules-error" role="alert">{error}</p> : null}
      {loading ? <p>{t("plugins.schedules.loading")}</p> : !items.length ? <p>{t("plugins.schedules.empty")}</p> : (
        <div className="plugin-schedules-list">
          {items.map((item) => {
            const id = `${item.pluginId}/${item.scheduleId}`;
            const state = item.invalid ? t("plugins.schedules.invalid") : !item.enabled ? t("plugins.schedules.disabled") : item.paused
              ? t(item.attempts >= 5 ? "plugins.schedules.pausedFailure" : "plugins.schedules.paused")
              : t("plugins.schedules.active");
            return (
              <article className="plugin-schedules-item" key={id}>
                <div className="plugin-schedules-heading">
                  <div><strong>{item.title}</strong><div className="plugin-schedules-plugin">{item.pluginName}</div></div>
                  <Badge tone={item.invalid ? "error" : item.paused ? "warning" : "neutral"}>{state}</Badge>
                </div>
                <dl className="plugin-schedules-facts">
                  <div><dt>{t("plugins.schedules.period")}</dt><dd>{item.period}</dd></div>
                  <div><dt>{t("plugins.schedules.lastRun")}</dt><dd>{date(item.lastRunAt)}</dd></div>
                  <div><dt>{t("plugins.schedules.lastResult")}</dt><dd>{item.lastOk === null ? t("plugins.schedules.none") : t(item.lastOk ? "plugins.schedules.success" : "plugins.schedules.failure")}</dd></div>
                  <div><dt>{t("plugins.schedules.nextRun")}</dt><dd>{date(item.nextRunAt)}</dd></div>
                </dl>
                <div className="plugin-schedules-actions">
                  <Button size="sm" variant="secondary" disabled={!item.enabled || Boolean(busy)} onClick={() => void act(item, "pause")}>{t(item.paused ? "plugins.schedules.resume" : "plugins.schedules.pause")}</Button>
                  <Button size="sm" variant="secondary" disabled={!item.enabled || item.paused || item.invalid || Boolean(busy)} onClick={() => void act(item, "run")}>{t("plugins.schedules.runNow")}</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
