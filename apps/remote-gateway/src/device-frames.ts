/**
 * The frames the Gateway relays for account mode, and which Hosts may receive
 * them (protocol §11.5, D666 / rollout R7 package D).
 *
 * Two rules live here, and they are not the same rule:
 *
 * - a **grant** goes only to a Host that announced
 *   `device.accept-sibling-grant`, so a Host that would refuse it is never
 *   offered one (ADR decision 9, security §3.8);
 * - a **revocation** goes to every Host that announced a capability frame at
 *   all — every Host with a device directory — because a Host may have adopted
 *   the device while it was not strict, or while it had a confirmer, and then
 *   restarted in strict mode or without one. Filtering revocations by
 *   `device.accept-sibling-grant` would leave exactly that Host accepting a
 *   revoked token.
 *
 * A Host that never announced anything predates these frames: it ignores an
 * unknown `type` silently, so it must never be sent a device frame at all.
 *
 * Both builders copy the signed fields verbatim. `deliverUntil` is part of the
 * signature, and rewriting it — even to shorten it — would make every sibling
 * refuse the grant.
 */
import {
  RACP_HOST_CAPABILITIES,
  RACP_HOSTLINK_VERSION,
  hostAdvertisesCapability,
  type RacpDeviceGrantFrame,
  type RacpDeviceRevokeFrame,
  type RacpHostLinkFrame,
} from "@minih-agent/shared";

import type { GatewayPendingGrantRecord, GatewayPendingRevocationRecord, GatewayStore } from "./store.js";

/**
 * The Host-link surface the relay needs. `HostLinkServer` satisfies it; keeping
 * it structural avoids a cycle between the listener and this service.
 */
export type DeviceRelayPort = {
  isOnline(hostId: string): boolean;
  /** The capability list the Host announced on its current link; empty when offline. */
  capabilitiesFor(hostId: string): readonly string[];
  /** Whether the Host announced capabilities on its current link at all. */
  hasAnnouncedCapabilities(hostId: string): boolean;
  /** Send one frame to a Host; false when it has no live link. */
  sendToHost(hostId: string, frame: RacpHostLinkFrame): boolean;
};

/** The grant as the siblings receive it: no `deviceToken`, ever (gate 30). */
export function relayGrantFrame(pending: GatewayPendingGrantRecord): RacpDeviceGrantFrame {
  return {
    link: RACP_HOSTLINK_VERSION,
    type: "device.grant",
    grant: {
      grantId: pending.grantId,
      requestId: pending.requestId,
      accountId: pending.accountId,
      signerHostId: pending.signerHostId,
      deviceId: pending.deviceId,
      deviceLabel: pending.deviceLabel,
      tokenHash: pending.tokenHash,
      roles: [...pending.roles],
      origin: "gateway",
      issuedAt: pending.issuedAt,
      // Exactly as the approving Host signed it.
      deliverUntil: pending.deliverUntil,
      // The desktop-class fields are inside the signature too: a Gateway that
      // dropped or relabelled them would break it at every sibling.
      ...(pending.deviceClass ? { deviceClass: pending.deviceClass } : {}),
      ...(pending.applicantHostId ? { applicantHostId: pending.applicantHostId } : {}),
      ...(pending.hostProofNonce ? { hostProofNonce: pending.hostProofNonce } : {}),
      ...(pending.requestExpiresAt ? { requestExpiresAt: pending.requestExpiresAt } : {}),
    },
    signature: pending.signature,
    signerCertificate: pending.signerCertificate,
  };
}

/** The revocation as the siblings receive it, exactly as the Host signed it. */
export function relayRevocationFrame(record: GatewayPendingRevocationRecord): RacpDeviceRevokeFrame {
  return {
    link: RACP_HOSTLINK_VERSION,
    type: "device.revoke",
    revoke: {
      revokeId: record.revokeId,
      accountId: record.accountId,
      signerHostId: record.signerHostId,
      deviceId: record.deviceId,
      revokedAt: record.revokedAt,
    },
    signature: record.signature,
    signerCertificate: record.signerCertificate,
  };
}

/** Whether this Host is online and adopts a sibling's grant (§11.5). */
export function acceptsSiblingGrants(hostLinks: DeviceRelayPort, hostId: string): boolean {
  if (!hostLinks.isOnline(hostId)) return false;
  return hostAdvertisesCapability(hostLinks.capabilitiesFor(hostId), RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant);
}

/**
 * Whether this Host can be asked to admit a desktop-class device: it is online
 * and advertises `device.desktop-auto` (ADR amendment 3, decision 6). A Host
 * that does not is never sent the new frames, because an older Host drops an
 * unknown `type` silently and the requesting desktop would wait forever.
 */
export function admitsDesktopDevices(hostLinks: DeviceRelayPort, hostId: string): boolean {
  if (!hostLinks.isOnline(hostId)) return false;
  return hostAdvertisesCapability(hostLinks.capabilitiesFor(hostId), RACP_HOST_CAPABILITIES.deviceDesktopAuto);
}

/** Send one frame to every other Host of the account that may receive it. */
export function relayToSiblings(input: {
  store: GatewayStore;
  hostLinks: DeviceRelayPort;
  accountId: string;
  signerHostId: string;
  frame: RacpHostLinkFrame;
  /** `accepts`: only Hosts that adopt a sibling's grant. `any`: any Host with a device directory. */
  audience: "accepts" | "any";
}): string[] {
  const relayed: string[] = [];
  for (const sibling of input.store.listHostsForAccount(input.accountId)) {
    if (sibling.hostId === input.signerHostId) continue;
    if (!input.hostLinks.isOnline(sibling.hostId)) continue;
    const reachable =
      input.audience === "accepts"
        ? acceptsSiblingGrants(input.hostLinks, sibling.hostId)
        : input.hostLinks.hasAnnouncedCapabilities(sibling.hostId);
    if (!reachable) continue;
    if (input.hostLinks.sendToHost(sibling.hostId, input.frame)) relayed.push(sibling.hostId);
  }
  return relayed;
}
