import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskView } from "@minih-agent/shared";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { asksBeforeDiscarding } from "./task-workspace";

/**
 * Archiving a task, as one labelled control beside the header's other actions.
 *
 * It used to sit inside the chip row, where it read as one more chip and made a
 * row that did not fit. Archiving is an action on the task, so it belongs in the
 * action group.
 *
 * The refusal "this workspace still holds work" is a question, not a failure: the
 * person's second click is what passes `discard`, and it is the only path to it.
 * Anything else is reported through the app's own toast, which is where every
 * other action failure in this window goes.
 */
export function TaskArchiveButton({ task }: { task: TaskView }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);

  if (task.archivedAt) return null;

  const archive = async () => {
    setBusy(true);
    try {
      try {
        await api.archiveTask(task.id);
      } catch (cause) {
        // "It still holds work" and "it could not be checked" both ask before
        // discarding; anything else is a real failure the person should see.
        const code = (cause as { code?: string } | null)?.code;
        if (!asksBeforeDiscarding(code)) throw cause;
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (!window.confirm(t("bots.tasks.archiveDiscardConfirm", { detail }))) return;
        await api.archiveTask(task.id, true);
      }
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy}
      data-task-archive=""
      onClick={() => void archive()}
    >
      {t("bots.tasks.archive")}
    </Button>
  );
}