/**
 * Pair screen (PR-4).
 *
 * The ticket is pasted, parsed, spent, and dropped: the pairing token is
 * single-use and is never stored, logged, or put in a URL. The device label
 * defaults to a name derived from the user agent.
 */
import { parsePairingTicket, type PairingTicketRejection } from "@minih-agent/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AppShell, Button, Card, FailureBanner } from "../components/Chrome.js";
import { defaultDeviceLabel } from "../lib/device-label.js";
import type { OperationFailure } from "../lib/errors.js";
import { credentialPort, gatewayOrigin } from "../lib/runtime.js";
import type { HostRegistryEntry } from "../lib/host-registry.js";

export function PairScreen({
  onPaired,
  onBack,
}: {
  onPaired: (entry: HostRegistryEntry) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [ticket, setTicket] = useState("");
  const [label, setLabel] = useState(() => defaultDeviceLabel(globalThis.navigator?.userAgent ?? ""));
  const [pairing, setPairing] = useState(false);
  const [rejection, setRejection] = useState<PairingTicketRejection | null>(null);
  const [failure, setFailure] = useState<OperationFailure | null>(null);

  const submit = async (): Promise<void> => {
    const parsed = parsePairingTicket(ticket);
    if (!parsed.ok) {
      setRejection(parsed.reason);
      return;
    }
    setRejection(null);
    setPairing(true);
    const outcome = await credentialPort.pair({
      gatewayOrigin,
      hostId: parsed.ticket.hostId,
      pairingToken: parsed.ticket.pairingToken,
      deviceLabel: label,
    });
    // The token is spent either way: drop it from the screen and from memory.
    setTicket("");
    setPairing(false);
    if (!outcome.ok) {
      setFailure({ code: outcome.failure.code, message: outcome.failure.message, retriable: false });
      return;
    }
    setFailure(null);
    onPaired(outcome.entry);
  };

  return (
    <AppShell title={t("pair.title")} onBack={onBack}>
      <Card>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("pair.intro")}</p>
        <label className="mt-3 block text-sm font-medium" htmlFor="pair-ticket">
          {t("pair.ticketLabel")}
        </label>
        <textarea
          id="pair-ticket"
          value={ticket}
          rows={2}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t("pair.ticketPlaceholder")}
          onChange={(event) => setTicket(event.target.value)}
          className="app-mono mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("pair.ticketCleared")}</p>

        <label className="mt-3 block text-sm font-medium" htmlFor="pair-label">
          {t("pair.deviceLabelLabel")}
        </label>
        <input
          id="pair-label"
          value={label}
          maxLength={128}
          placeholder={t("pair.deviceLabelPlaceholder")}
          onChange={(event) => setLabel(event.target.value)}
          className="app-tap mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />

        <div className="mt-4 flex gap-2">
          <Button variant="primary" disabled={pairing || ticket.trim().length === 0} onClick={() => void submit()}>
            {pairing ? t("pair.pairing") : t("pair.submit")}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            {t("common.cancel")}
          </Button>
        </div>
      </Card>
      {rejection ? <FailureBanner failure={{ code: "PAIRING_FAILED", message: t(`pair.invalid.${rejection}`), retriable: false }} operationKey="operation.pair" /> : null}
      {failure ? <FailureBanner failure={failure} operationKey="operation.pair" onDismiss={() => setFailure(null)} /> : null}
    </AppShell>
  );
}
