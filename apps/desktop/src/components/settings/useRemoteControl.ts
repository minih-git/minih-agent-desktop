/**
 * Remote control for the accounts page (rollout R5, ADR 0331).
 *
 * The desktop as a connected Host: it dials the user's own Gateway over one
 * outbound Host link and never opens a listener. Everything here steers a link
 * the main process owns, so unmounting only drops this renderer's status
 * subscription — a reload does not disconnect a remote device.
 *
 * The state lives in one hook because two sections render it: the visible
 * account-mode block (switch, link state, devices) and the collapsed
 * self-hosted gateway area, whose enrollment form feeds the same status.
 *
 * Only the pairing code is a secret here, and it is meant to be read off the
 * screen: every other value (certificate, registration code, device list) is
 * either public or redacted by main.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPairingTicket } from "@minih-agent/shared";
import type {
  RemoteGatewayDeviceNotice,
  RemoteGatewayDeviceSummary,
  RemoteGatewayStatus,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { pairingCodeExpired, remoteGatewayErrorKey } from "../../lib/remote-gateway-state";

type PairingCode = { code: string; expiresAt: string; hostId: string };


/** Keeps at most this many "new device" notices on screen. */
const MAX_VISIBLE_NOTICES = 3;

export type RemoteControl = {
  status: RemoteGatewayStatus | null;
  statusError: string | null;
  devices: RemoteGatewayDeviceSummary[] | null;
  devicesError: string | null;
  notices: RemoteGatewayDeviceNotice[];
  /** Self-hosted enrollment form, which lives in the advanced area. */
  url: string;
  caPem: string;
  registrationCode: string;
  enrolling: boolean;
  enrollError: string | null;
  enrollSucceeded: boolean;
  urlTouched: { current: boolean };
  pairing: {
    code: PairingCode | null;
    busy: boolean;
    error: string | null;
    copied: boolean;
    copiedTicket: boolean;
    remainingMs: number;
  };
  toggle: { busy: boolean; error: string | null };
  strict: { busy: boolean; error: string | null };
  revoke: { pending: string | null; busy: string | null };
  setUrl: (value: string) => void;
  setCaPem: (value: string) => void;
  setRegistrationCode: (value: string) => void;
  setPendingRevoke: (deviceId: string | null) => void;
  onToggle: () => Promise<void>;
  onEnroll: () => Promise<void>;
  onToggleStrict: () => Promise<void>;
  onCreatePairingCode: () => Promise<void>;
  onCopyPairingCode: () => Promise<void>;
  onCopyPairingTicket: () => Promise<void>;
  onRevoke: (device: RemoteGatewayDeviceSummary) => Promise<void>;
};

export function useRemoteControl(): RemoteControl {
  const { t } = useTranslation();

  const [status, setStatus] = useState<RemoteGatewayStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [caPem, setCaPem] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollSucceeded, setEnrollSucceeded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedTicket, setCopiedTicket] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [devices, setDevices] = useState<RemoteGatewayDeviceSummary[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [notices, setNotices] = useState<RemoteGatewayDeviceNotice[]>([]);
  const [strictBusy, setStrictBusy] = useState(false);
  const [strictError, setStrictError] = useState<string | null>(null);
  const urlTouched = useRef(false);

  const describeError = useCallback(
    (prefixKey: string, error: unknown) =>
      t(prefixKey, { message: t(remoteGatewayErrorKey(error)) }),
    [t],
  );

  const applyStatus = useCallback((next: RemoteGatewayStatus) => {
    setStatus(next);
    setStatusError(null);
    // The stored URL is the default until the user edits the field.
    if (!urlTouched.current && next.url) setUrl(next.url);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      applyStatus(await api.remoteGatewayStatus());
    } catch (error) {
      setStatusError(t("settings.remoteGateway.statusFailed", { message: t(remoteGatewayErrorKey(error)) }));
    }
  }, [applyStatus, t]);

  const loadDevices = useCallback(async () => {
    try {
      const result = await api.listRemoteGatewayDevices();
      setDevices(result.devices);
      setDevicesError(null);
    } catch (error) {
      setDevices(null);
      setDevicesError(t("settings.remoteGateway.devicesFailed", { message: t(remoteGatewayErrorKey(error)) }));
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
    void loadDevices();
    // A renderer reload re-subscribes here; the link itself belongs to main
    // and is deliberately left running.
    const unsubscribe = api.onRemoteGatewayStatus(applyStatus);
    // Every mint, adoption, and revocation produces a notice (ADR decision 6):
    // a device that was approved on another Host shows up here too.
    const unsubscribeNotices = api.onRemoteGatewayDeviceNotice((notice) => {
      setNotices((prev) => [notice, ...prev].slice(0, MAX_VISIBLE_NOTICES));
      // A new device changes this Host's device list; a notice about what a
      // remote device did (a session it started, a project it registered) does
      // not, so the list is reloaded only for the device kinds.
      if (notice.kind === "device.adopted" || notice.kind === "device.revoked") void loadDevices();
    });
    return () => {
      unsubscribe();
      unsubscribeNotices();
    };
  }, [applyStatus, loadDevices, loadStatus]);

  // The pairing code is cleared from state the moment it expires, so a code
  // that is no longer redeemable cannot be copied out of the page.
  useEffect(() => {
    if (!pairingCode) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (pairingCodeExpired(pairingCode.expiresAt, current)) setPairingCode(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [pairingCode]);

  const onToggle = useCallback(async () => {
    if (!status) return;
    setToggling(true);
    setToggleError(null);
    try {
      applyStatus(await api.setRemoteGatewayEnabled(!status.enabled));
    } catch (error) {
      setToggleError(describeError("settings.remoteGateway.toggleFailed", error));
    } finally {
      setToggling(false);
    }
  }, [applyStatus, describeError, status]);

  const onEnroll = useCallback(async () => {
    const trimmedUrl = url.trim();
    const trimmedCa = caPem.trim();
    const trimmedCode = registrationCode.trim();
    if (!trimmedUrl || !trimmedCa || !trimmedCode) {
      setEnrollError(t("settings.remoteGateway.errorInvalidInput"));
      return;
    }
    setEnrolling(true);
    setEnrollError(null);
    setEnrollSucceeded(false);
    try {
      applyStatus(await api.enrollRemoteGateway({ url: trimmedUrl, caPem: trimmedCa, code: trimmedCode }));
      // The registration code is single use; never keep it in renderer state.
      setRegistrationCode("");
      setEnrollSucceeded(true);
      await loadDevices();
    } catch (error) {
      setEnrollError(describeError("settings.remoteGateway.enrollFailed", error));
    } finally {
      setEnrolling(false);
    }
  }, [applyStatus, caPem, describeError, loadDevices, registrationCode, t, url]);

  /**
   * ADR decision 9. The switch is device-local and takes effect by rebuilding
   * the link, because the capability list is part of what the Host announces:
   * a strict-mode Host stops advertising `device.accept-sibling-grant`.
   */
  const onToggleStrict = useCallback(async () => {
    if (!status) return;
    setStrictBusy(true);
    setStrictError(null);
    try {
      applyStatus(await api.setRemoteGatewayStrictDevices(status.strictDevices !== true));
    } catch (error) {
      setStrictError(describeError("settings.remoteGateway.strictFailed", error));
    } finally {
      setStrictBusy(false);
    }
  }, [applyStatus, describeError, status]);

  const onCreatePairingCode = useCallback(async () => {
    setPairingBusy(true);
    setPairingError(null);
    setCopied(false);
    setCopiedTicket(false);
    try {
      const result = await api.createRemoteGatewayPairingCode();
      setNow(Date.now());
      // The ticket names the Host the code belongs to; it is derived from the
      // code, so it expires and clears with it.
      setPairingCode({ code: result.code, expiresAt: result.expiresAt, hostId: result.hostId });
    } catch (error) {
      setPairingCode(null);
      setPairingError(describeError("settings.remoteGateway.pairingFailed", error));
    } finally {
      setPairingBusy(false);
    }
  }, [describeError]);

  const onCopyPairingCode = useCallback(async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode.code);
      setCopied(true);
      setPairingError(null);
    } catch {
      setCopied(false);
      setPairingError(t("settings.remoteGateway.copyFailed"));
    }
  }, [pairingCode, t]);

  const onCopyPairingTicket = useCallback(async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(formatPairingTicket(pairingCode.hostId, pairingCode.code));
      setCopiedTicket(true);
    } catch {
      setCopiedTicket(false);
      setPairingError(t("settings.remoteGateway.copyFailed"));
    }
  }, [pairingCode, t]);

  const onRevoke = useCallback(
    async (device: RemoteGatewayDeviceSummary) => {
      setRevoking(device.deviceId);
      setDevicesError(null);
      try {
        await api.revokeRemoteGatewayDevice(device.deviceId);
        setPendingRevoke(null);
        await loadDevices();
      } catch (error) {
        setDevicesError(t("settings.remoteGateway.revokeFailed", { message: t(remoteGatewayErrorKey(error)) }));
        // A failed revoke must leave the row usable: a confirmation left armed
        // would sit on top of the error and block the retry.
        setPendingRevoke(null);
      } finally {
        setRevoking(null);
      }
    },
    [loadDevices, t],
  );

  const remainingMs = pairingCode ? Date.parse(pairingCode.expiresAt) - now : 0;

  return {
    status,
    statusError,
    devices,
    devicesError,
    notices,
    url,
    caPem,
    registrationCode,
    enrolling,
    enrollError,
    enrollSucceeded,
    urlTouched,
    pairing: {
      code: pairingCode,
      busy: pairingBusy,
      error: pairingError,
      copied,
      copiedTicket,
      remainingMs,
    },
    toggle: { busy: toggling, error: toggleError },
    strict: { busy: strictBusy, error: strictError },
    revoke: { pending: pendingRevoke, busy: revoking },
    setUrl,
    setCaPem,
    setRegistrationCode,
    setPendingRevoke,
    onToggle,
    onEnroll,
    onToggleStrict,
    onCreatePairingCode,
    onCopyPairingCode,
    onCopyPairingTicket,
    onRevoke,
  };
}
