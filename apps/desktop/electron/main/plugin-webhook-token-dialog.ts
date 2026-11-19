import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { EnglishCatalog } from "@minih-agent/i18n";

type Labels = EnglishCatalog["plugins"]["webhook"];
type Dependencies = {
  labels: Labels;
  show: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  reveal: () => Promise<string>;
  rotate: () => Promise<string>;
  copy: (value: string) => void;
};

/** The secret exists only in Main and a native system dialog, never in renderer IPC. */
export async function showWebhookTokenDialog({ labels, show, reveal, rotate, copy }: Dependencies): Promise<void> {
  const action = await show({
    type: "question",
    title: labels.tokenActionsTitle,
    message: labels.tokenActionsTitle,
    detail: labels.tokenActionsBody,
    buttons: [labels.tokenShow, labels.tokenRotate, labels.tokenCancel],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  });
  if (action.response === 2) return;
  if (action.response !== 0 && action.response !== 1) throw new Error("Invalid webhook token action");
  if (action.response === 1) {
    const confirmation = await show({
      type: "warning",
      title: labels.tokenRotateTitle,
      message: labels.tokenRotateTitle,
      detail: labels.tokenRotateBody,
      buttons: [labels.tokenCancel, labels.tokenRotate],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return;
  }
  const token = action.response === 1 ? await rotate() : await reveal();
  const result = await show({
    type: "info",
    title: labels.tokenValueTitle,
    message: labels.tokenValueBody,
    detail: token,
    buttons: [labels.tokenCopy, labels.tokenClose],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) copy(token);
}
