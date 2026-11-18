export type PluginScheduleView = {
  pluginId: string;
  pluginName: string;
  scheduleId: string;
  title: string;
  period: string;
  lastRunAt: number | null;
  lastOk: boolean | null;
  nextRunAt: number | null;
  paused: boolean;
  attempts: number;
  invalid: boolean;
  enabled: boolean;
};
