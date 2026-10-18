/**
 * Account-mode device confirmation (protocol §11.5, D666; rollout R7 package E2).
 *
 * A phone that logged in with the account AccessKey asks for a device token.
 * The Gateway sends `device.request` to every online Host of the account, and
 * this desktop is one of them: main pushes the request here, the person at the
 * machine sees who is asking, and the answer goes back over IPC.
 *
 * Denial is the safe default and every way of "not answering" lands there: the
 * requester's own `expiresAt` closes the dialog, Escape and the backdrop deny,
 * and unmounting the host (window closed, renderer reloaded) tells main to
 * refuse whatever was still waiting. That is why this component reports
 * presence on mount and on unmount instead of only keeping its own state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteGatewayDeviceRequest } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { OverlayBackdrop, Button } from "../ui";

/** One request, one modal. Mounted only while a request is waiting. */
function DeviceRequestDialog({
  request,
  onAnswer,
}: {
  request: RemoteGatewayDeviceRequest;
  onAnswer: (approved: boolean) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = Date.parse(request.expiresAt);
  useBlockingOverlay();

  // The requester's own deadline closes the dialog: the Gateway has given up by
  // then, so an answer would be meaningless.
  useEffect(() => {
    const tick = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow);
      if (currentNow >= expiresAt) onAnswer(false);
    }, 1000);
    return () => clearInterval(tick);
  }, [expiresAt, onAnswer]);

  // Focus lands on the deny button: the safe answer is the easy one, and a
  // stray Return must not approve a remote device.
  useEffect(() => {
    requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>("[data-safe-action]")?.focus(),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onAnswer(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onAnswer]);

  const remaining = Number.isFinite(expiresAt)
    ? Math.max(0, Math.ceil((expiresAt - now) / 1000))
    : 0;

  const dialog = (
    <OverlayBackdrop
      className="overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onAnswer(false);
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="device-request-title"
        aria-describedby="device-request-body"
      >
        <h2 id="device-request-title" className="dialog-title">
          {t("settings.remoteGateway.deviceRequestTitle")}
        </h2>
        <div id="device-request-body" className="space-y-2 text-sm text-text-secondary">
          <p>{t("settings.remoteGateway.deviceRequestBody", { label: request.deviceLabel })}</p>
          <p className="text-xs">
            {t("settings.remoteGateway.deviceRequestClient", { client: request.client })}
          </p>
          <p className="text-xs" aria-live="polite">
            {t("settings.remoteGateway.deviceRequestExpires", { seconds: remaining })}
          </p>
          <p className="text-xs">{t("settings.remoteGateway.deviceRequestHint")}</p>
        </div>
        <div className="dialog-actions flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            data-safe-action="true"
            onClick={() => onAnswer(false)}
          >
            {t("settings.remoteGateway.deviceRequestDeny")}
          </Button>
          <Button type="button" variant="primary" onClick={() => onAnswer(true)}>
            {t("settings.remoteGateway.deviceRequestApprove")}
          </Button>
        </div>
      </div>
    </OverlayBackdrop>
  );
  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}

export function DeviceRequestHost() {
  const [queue, setQueue] = useState<RemoteGatewayDeviceRequest[]>([]);

  useEffect(() => {
    // A dialog can be shown from here on. `false` on unmount refuses everything
    // waiting, so no client waits on a window nobody can see.
    void api.setRemoteGatewayDevicePresence(true).catch(() => undefined);
    const offRequest = api.onRemoteGatewayDeviceRequest((request) => {
      setQueue((prev) =>
        prev.some((item) => item.requestId === request.requestId) ? prev : [...prev, request],
      );
    });
    // A reloaded renderer re-opens the dialogs that are still pending.
    void api
      .pendingRemoteGatewayDeviceRequests()
      .then((result) => {
        setQueue((prev) => {
          const seen = new Set(prev.map((item) => item.requestId));
          return [...prev, ...result.requests.filter((item) => !seen.has(item.requestId))];
        });
      })
      .catch(() => undefined);
    return () => {
      offRequest();
      void api.setRemoteGatewayDevicePresence(false).catch(() => undefined);
    };
  }, []);

  const current = queue[0] ?? null;
  const answer = useCallback((requestId: string, approved: boolean) => {
    setQueue((prev) => prev.filter((item) => item.requestId !== requestId));
    // Main owns the deadline: an answer that arrives after it is refused there.
    void api.answerRemoteGatewayDevice(requestId, approved).catch(() => undefined);
  }, []);

  if (!current) return null;
  return (
    <DeviceRequestDialog
      key={current.requestId}
      request={current}
      onAnswer={(approved) => answer(current.requestId, approved)}
    />
  );
}
