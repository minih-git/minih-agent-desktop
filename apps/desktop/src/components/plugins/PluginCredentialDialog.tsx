import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PluginCredentialDialogRequest,
  PluginCredentialStatus,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { Button, cx, portalOverlay } from "../ui";
import {
  CredentialFieldsForm,
  valuesComplete,
  type CredentialValues,
} from "./PluginCredentials";

/**
 * The host's own form for a credential a plugin asked to add, and the
 * confirmation before one is removed (`pi.credentials.requestAdd` /
 * `requestRemove`).
 *
 * It is deliberately hosted by the shell rather than by any page: a plugin can ask
 * while the user is anywhere, and the answer has to reach Main whether or not the
 * Plugins settings page happens to be mounted. The values typed here go straight
 * back to Main; the plugin that asked receives only the new instance id.
 */
export function PluginCredentialDialog() {
  const { t, i18n } = useTranslation();
  const [request, setRequest] = useState<PluginCredentialDialogRequest | null>(null);
  const [slot, setSlot] = useState<PluginCredentialStatus | null>(null);
  const [values, setValues] = useState<CredentialValues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The overlay is modal in the renderer, but a plugin view is a native
  // `WebContentsView` that draws above it: registering the dialog is what
  // removes the view from the screen while the user answers, and unregistering
  // is what brings it back afterwards.
  useBlockingOverlay(request !== null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus has to move with the overlay. If the keys stayed in the plugin page
  // underneath, Escape would reach the plugin and the form below would be
  // unreachable without a pointer.
  useLayoutEffect(() => {
    if (!request) return;
    const target =
      dialogRef.current?.querySelector<HTMLElement>(
        "input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
      ) ?? dialogRef.current;
    target?.focus({ preventScroll: true });
  }, [request, slot]);

  useEffect(
    () =>
      api.onPluginCredentialDialog((next) => {
        setRequest(next);
        setValues({});
        setError(null);
      }),
    [],
  );

  // The declaration comes from the installed manifest through the same status
  // call the Settings sheet uses, so the dialog renders exactly that slot.
  useEffect(() => {
    if (!request) return;
    let active = true;
    setSlot(null);
    if (request.kind !== "add") return;
    api.getPluginCredentials(request.pluginId).then(
      (result) => {
        if (active) setSlot(result.slots.find((entry) => entry.id === request.slotId) ?? null);
      },
      () => {
        if (active) setError(t("pluginCredentials.loadFailed"));
      },
    );
    return () => {
      active = false;
    };
  }, [request, t]);

  if (!request) return null;
  const locale = i18n.resolvedLanguage ?? "en";
  const adding = request.kind === "add";
  const title = adding
    ? t("pluginCredentials.dialogTitleAdd", { plugin: request.pluginName })
    : t("pluginCredentials.dialogTitleRemove", { plugin: request.pluginName });

  const close = async (answer: Parameters<typeof api.answerPluginCredentialDialog>[1]) => {
    setBusy(true);
    try {
      await api.answerPluginCredentialDialog(request.requestId, answer);
    } catch {
      // The dialog was already closed or timed out; nothing is left to answer.
    } finally {
      setBusy(false);
      setRequest(null);
      setSlot(null);
    }
  };

  return portalOverlay(
    <div className="plugins-modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className={cx("plugins-modal", "plugin-credential-dialog")}
        // Lets the E2E name the exact dialog it is answering.
        data-request-id={request.requestId}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Focusable so the confirmation variant, which has no field, can still
        // take the keyboard and answer Escape.
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || busy) return;
          event.preventDefault();
          event.stopPropagation();
          void close({ action: "cancel" });
        }}
      >
        <header className="plugins-modal-head">
          <div className="plugins-settings-heading">
            <h2 className="plugins-modal-title">{title}</h2>
            <p className="plugins-modal-subtitle">
              {adding
                ? t("pluginCredentials.dialogHintAdd", { plugin: request.pluginName })
                : t("pluginCredentials.dialogHintRemove", {
                    label: request.instanceLabel || request.instanceId || "",
                  })}
            </p>
          </div>
        </header>
        <div className="plugins-settings-body">
          {adding ? (
            slot ? (
              <CredentialFieldsForm
                fields={slot.fields}
                values={values}
                onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
                locale={locale}
                disabled={busy}
                userEndpoint={slot.userEndpoint}
                userProxy={slot.userProxy}
                userSend={slot.userSend}
              />
            ) : (
              <p role="alert">{error ?? t("pluginCredentials.loadFailed")}</p>
            )
          ) : null}
          {error && adding && slot ? <p role="alert">{error}</p> : null}
        </div>
        <div className="plugins-modal-actions">
          <Button variant="secondary" disabled={busy} onClick={() => void close({ action: "cancel" })}>
            {t("pluginCredentials.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || (adding ? !slot || !valuesComplete(slot.fields, values) : false)}
            onClick={() =>
              void close(
                adding ? { action: "submit", fields: values } : { action: "confirm" },
              )
            }
          >
            {adding ? t("pluginCredentials.save") : t("pluginCredentials.confirmRemove")}
          </Button>
        </div>
      </div>
    </div>,
  );
}