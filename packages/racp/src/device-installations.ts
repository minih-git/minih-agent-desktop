import type { DeviceCredentialStore, DeviceRecord } from "./auth.js";

export type DeviceInstallationRecord = Pick<DeviceRecord,
  "deviceId" | "origin" | "accountId" | "deviceClass" | "applicantHostId" | "installationId" | "grantRequestId" | "grantIssuedAt" | "createdAt">;

/** Correlation is scoped to the grant channel and account, never to a label. */
export function deviceInstallationMatches(left: DeviceInstallationRecord, right: DeviceInstallationRecord): boolean {
  if (left.origin !== right.origin || (left.accountId && right.accountId && left.accountId !== right.accountId)) return false;
  if (left.deviceClass === "desktop" || right.deviceClass === "desktop") {
    return left.deviceClass === "desktop" && right.deviceClass === "desktop"
      && !!left.applicantHostId && left.applicantHostId === right.applicantHostId;
  }
  return left.accountId === right.accountId && !!left.installationId
    && left.installationId === right.installationId;
}

export function compareDeviceInstallations(left: DeviceInstallationRecord, right: DeviceInstallationRecord): number {
  const time = Date.parse(left.grantIssuedAt ?? left.createdAt) - Date.parse(right.grantIssuedAt ?? right.createdAt);
  return time || (left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0);
}

/**
 * Persist replacement tombstones after normal approval and token persistence.
 * Same-request admissions are left to the Gateway's existing first-grant rule.
 * Retained tombstones also stop an older deferred grant displacing a newer one.
 */
export async function replaceDeviceInstallation(
  store: DeviceCredentialStore,
  current: DeviceRecord,
  at: string,
): Promise<DeviceRecord[]> {
  const matches = (await store.listDevices()).filter((device) =>
    device.deviceId !== current.deviceId && deviceInstallationMatches(device, current)
    && !(current.grantRequestId && current.grantRequestId === device.grantRequestId));
  const newer = matches.filter((device) => compareDeviceInstallations(device, current) > 0).sort(compareDeviceInstallations).at(-1);
  const replaced = newer ? [current] : matches.filter((device) => !device.revokedAt);
  const replacement = newer ?? current;
  for (const device of replaced) {
    await store.saveDevice({ ...device, revokedAt: device.revokedAt ?? at, replacedByDeviceId: replacement.deviceId });
  }
  return replaced;
}
