/**
 * S3 Pair screen (PR-4).
 *
 * Implements S3 Pairing Ticket screen per docs/spec/04-ux/13-remote-mobile-client.md §8.4
 * and apps/remote-web/design/prototype/index.html.
 */
import { parsePairingTicket } from "@minih-agent/shared";
import { AlertCircle, Check, Smartphone } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { TicketField } from "../components/ui/Fields.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { defaultDeviceLabel, nativeDeviceLabel } from "../lib/device-label.js";
import type { OperationFailure } from "../lib/errors.js";
import type { HostRegistryEntry } from "../lib/host-registry.js";
import { credentialPort, gatewayOrigin, nativePlatform } from "../lib/runtime.js";

export function PairScreen({
  onPaired,
  onBack,
}: {
  onPaired: (entry: HostRegistryEntry) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [ticket, setTicket] = useState("");
  const [label, setLabel] = useState(() =>
    nativePlatform
      ? nativeDeviceLabel(nativePlatform)
      : defaultDeviceLabel(globalThis.navigator?.userAgent ?? ""),
  );
  const [pairing, setPairing] = useState(false);
  const [failure, setFailure] = useState<OperationFailure | null>(null);

  const parsedTicket = useMemo<ReturnType<typeof parsePairingTicket> | null>(() => {
    const trimmed = ticket.trim();
    if (!trimmed) return null;
    return parsePairingTicket(trimmed);
  }, [ticket]);

  const isValid = parsedTicket?.ok === true;

  const submit = async (): Promise<void> => {
    if (!parsedTicket || !parsedTicket.ok) {
      return;
    }
    setPairing(true);
    setFailure(null);
    try {
      const outcome = await credentialPort.pair({
        gatewayOrigin,
        hostId: parsedTicket.ticket.hostId,
        pairingToken: parsedTicket.ticket.pairingToken,
        deviceLabel: label.trim() || undefined,
      });
      // The token is single-use and spent: clear from screen and state
      setTicket("");
      setPairing(false);
      if (!outcome.ok) {
        setFailure({
          code: outcome.failure.code,
          message: outcome.failure.message,
          retriable: false,
        });
        return;
      }
      onPaired(outcome.entry);
    } catch (err) {
      setTicket("");
      setPairing(false);
      setFailure({
        code: "PAIR_FAILED",
        message: err instanceof Error ? err.message : String(err),
        retriable: false,
      });
    }
  };

  return (
    <Screen>
      <NavBar title={t("pair.title")} onBack={onBack} />
      <ScreenContent hasDock={true} className="pt-3 space-y-4">
        <Callout tone="neutral">
          <ol className="list-decimal pl-4 space-y-1 text-[13px] leading-[18px]">
            <li>{t("pair.step1")}</li>
            <li>{t("pair.step2")}</li>
          </ol>
        </Callout>

        <div className="space-y-1.5">
          <TicketField
            id="pair-ticket"
            label={t("pair.ticketLabel")}
            placeholder={t("pair.ticketPlaceholder")}
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            onPasteText={(pasted) => setTicket(pasted.trim())}
            pasteLabel={t("pair.paste")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {ticket.trim().length === 0 ? (
            <p className="ml-1 text-[12px] leading-[16px] text-[var(--rm-text-muted)]">
              {t("pair.ticketCleared")}
            </p>
          ) : parsedTicket?.ok ? (
            <p className="ml-1 flex items-center gap-1.5 text-[12px] leading-[16px] font-medium text-[var(--rm-success)]">
              <Check className="h-3.5 w-3.5 stroke-[2.5]" aria-hidden="true" />
              <span>
                {t("pair.validTicket", {
                  hostId: `${parsedTicket.ticket.hostId.slice(0, 8)}…`,
                })}
              </span>
            </p>
          ) : (
            <p className="ml-1 flex items-center gap-1.5 text-[12px] leading-[16px] text-[var(--rm-error)]">
              <AlertCircle className="h-3.5 w-3.5 stroke-[2]" aria-hidden="true" />
              <span>{t(`pair.invalid.${parsedTicket?.reason ?? "EMPTY"}`)}</span>
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="pair-label"
            className="ml-1 block text-[13px] font-normal leading-[18px] text-[var(--rm-text-muted)]"
          >
            {t("pair.deviceLabelLabel")}
          </label>
          <div className="flex min-h-[52px] w-full items-center gap-2.5 rounded-[12px] bg-[var(--rm-bg-surface)] px-3.5 shadow-[inset_0_0_0_1px_var(--rm-separator)] transition-shadow focus-within:shadow-[inset_0_0_0_2px_var(--rm-accent)]">
            <Smartphone className="h-5 w-5 text-[var(--rm-text-muted)] shrink-0" aria-hidden="true" />
            <input
              id="pair-label"
              value={label}
              maxLength={128}
              placeholder={t("pair.deviceLabelPlaceholder")}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-transparent text-[16px] leading-[24px] text-[var(--rm-text-primary)] outline-none"
            />
          </div>
        </div>

        {failure ? (
          <Banner tone="error">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{t("operation.pair")}</span>
              <span className="text-[13px] opacity-90">{failure.message}</span>
            </div>
          </Banner>
        ) : null}
      </ScreenContent>

      <ScreenDock>
        <Button
          variant="primary"
          size="large"
          loading={pairing}
          disabled={!isValid || pairing}
          onClick={() => void submit()}
        >
          {pairing ? t("pair.pairing") : t("pair.submit")}
        </Button>
      </ScreenDock>
    </Screen>
  );
}
