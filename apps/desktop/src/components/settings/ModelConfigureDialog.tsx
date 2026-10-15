/**
 * The models page's per-model configure dialog.
 *
 * Editing a binding opens a modal instead of stretching its card: the binding
 * editor is a tall form, and the card grid must stay a scannable list of what
 * the row sends. The fields themselves are the shared `ModelBindingFields`, so
 * this dialog and the service dialog cannot drift apart.
 */
import { useTranslation } from "react-i18next";
import type { ModelBinding } from "@minih-agent/shared";
import { OverlayBackdrop, Button, portalOverlay } from "../ui";
import { ModelBindingFields } from "./ModelBindingFields";

export type ModelConfigureDialogProps = {
  /** The binding being edited (draft state included). */
  binding: ModelBinding;
  /** True while the caller saves, so the actions stop accepting input. */
  saving?: boolean;
  /** Wire styles this model may pin; absent hides the protocol override. */
  apiStyleOptions?: ReadonlyArray<{ id: string; label: string }>;
  /** The provider row's own global style, shown as the follow-global value. */
  globalApiStyle?: string;
  onClose: () => void;
  /** Persists the edited binding. */
  onSave: () => void;
  /** Live patch from a field; the dialog owns no copy of its own. */
  onChange: (patch: Partial<ModelBinding>) => void;
};

export function ModelConfigureDialog({
  binding,
  saving,
  apiStyleOptions,
  globalApiStyle,
  onClose,
  onSave,
  onChange,
}: ModelConfigureDialogProps) {
  const { t } = useTranslation();
  return portalOverlay(
    <OverlayBackdrop
      className="overlay model-configure-overlay"
      role="presentation"
      onClick={() => {
        if (saving) return;
        onClose();
      }}
    >
      <div
        className="dialog model-configure-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-configure-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="model-configure-head">
          <h4 id="model-configure-title" className="model-configure-title">
            {t("settings.modelsConfigureTitle", { model: binding.id })}
          </h4>
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            {t("settings.close")}
          </Button>
        </div>

        <div className="model-configure-body">
          <ModelBindingFields
            binding={binding}
            publishedLevels={[]}
            busy={saving}
            nativeWebSearchCapable
            apiStyleOptions={apiStyleOptions}
            globalApiStyle={globalApiStyle}
            onChange={onChange}
          />
        </div>

        <div className="model-configure-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button variant="primary" disabled={saving} onClick={onSave}>
            {t("settings.save")}
          </Button>
        </div>
      </div>
    </OverlayBackdrop>,
  );
}
