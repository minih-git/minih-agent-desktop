import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DeviceCredentialStore, DeviceRecord, PairingRecord } from "@minih-agent/racp";

import type { EncryptionPort } from "../remote-host-registry.js";
import type { HostLinkCredentials } from "./gateway-link-port.js";

/**
 * Device credentials and mTLS material for the desktop Host link (rollout R5,
 * ADR 0330).
 *
 * The file lives under `<userData>/remote-gateway/` and is encrypted as one
 * blob through `EncryptionPort`, the same OS-keychain path the paired-host
 * registry uses. It holds the Host id, the enrolled certificate and private
 * key, the paired-device records (token hashes only), and the outstanding
 * pairing tokens. Nothing here is ever written to SQLite or to host-core's
 * schema, and the renderer only ever sees a device summary.
 *
 * A file that exists but cannot be read or decrypted is a hard error: treating
 * it as empty would silently drop this desktop's Host identity and every
 * paired device, which no UI could recover from.
 */

export const GATEWAY_CREDENTIALS_UNREADABLE = "GATEWAY_CREDENTIALS_UNREADABLE";
export const GATEWAY_CREDENTIALS_STORAGE_UNAVAILABLE = "GATEWAY_CREDENTIALS_STORAGE_UNAVAILABLE";

/** The plaintext document inside the encrypted blob. */
type CredentialDocument = {
  version: 1;
  hostId: string;
  credentials?: HostLinkCredentials;
  devices: DeviceRecord[];
  pairings: PairingRecord[];
};

/** The on-disk envelope: the document exists only as ciphertext. */
type EncryptedEnvelope = {
  version: 1;
  /** Base64 of `EncryptionPort.encryptString` output. */
  payload: string;
};

export type GatewayCredentialStoreOptions = {
  /** Host data directory; the store creates `remote-gateway/` inside it. */
  dataDir: string;
  encryption: EncryptionPort;
  log?: (level: "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** Test seam for the generated Host id; defaults to `host_<uuid>`. */
  newHostId?: () => string;
  /** File name inside the `remote-gateway` directory. */
  fileName?: string;
};

export interface GatewayCredentialStore extends DeviceCredentialStore {
  /**
   * Read the file once. A missing file starts an empty store with a fresh
   * Host id that is only persisted by the first mutation, so a disabled
   * feature never creates one.
   */
  open(): Promise<void>;
  /** This desktop's stable Host id (available after `open()`). */
  hostId(): string;
  /** Whether an enrollment landed; false keeps the link off. */
  enrolled(): boolean;
  credentials(): HostLinkCredentials | undefined;
  saveCredentials(credentials: HostLinkCredentials): Promise<void>;
}

function credentialError(code: string, message: string, cause?: unknown): Error & { errorCode: string } {
  return Object.assign(new Error(message), {
    errorCode: code,
    ...(cause === undefined ? {} : { cause }),
  });
}

function fileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function isDocument(value: unknown): value is CredentialDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<CredentialDocument>;
  return (
    document.version === 1 &&
    typeof document.hostId === "string" &&
    document.hostId.trim().length > 0 &&
    Array.isArray(document.devices) &&
    Array.isArray(document.pairings)
  );
}

export function createGatewayCredentialStore(
  options: GatewayCredentialStoreOptions,
): GatewayCredentialStore {
  const log = options.log ?? (() => undefined);
  const newHostId = options.newHostId ?? (() => `host_${randomUUID()}`);
  const filePath = join(options.dataDir, "remote-gateway", options.fileName ?? "gateway-link.json");
  let document: CredentialDocument | null = null;
  let opening: Promise<void> | null = null;
  /** Every read-modify-write stays exclusive, so two pairings cannot race. */
  let mutationQueue: Promise<void> = Promise.resolve();

  const loaded = (): CredentialDocument => {
    if (!document) {
      throw credentialError(
        GATEWAY_CREDENTIALS_UNREADABLE,
        "the gateway credential store was used before it was opened",
      );
    }
    return document;
  };

  const load = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (fileNotFound(error)) {
        document = { version: 1, hostId: newHostId(), devices: [], pairings: [] };
        return;
      }
      log("error", "gateway credential file read failed", { file: filePath, error: String(error) });
      throw credentialError(
        GATEWAY_CREDENTIALS_UNREADABLE,
        "the gateway credential file could not be read",
        error,
      );
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      log("error", "gateway credential file is corrupt", { file: filePath, error: String(error) });
      throw credentialError(
        GATEWAY_CREDENTIALS_UNREADABLE,
        "the gateway credential file is not valid JSON",
        error,
      );
    }
    const payload = (envelope as Partial<EncryptedEnvelope> | null)?.payload;
    if (typeof payload !== "string" || payload.length === 0) {
      throw credentialError(
        GATEWAY_CREDENTIALS_UNREADABLE,
        "the gateway credential file has no encrypted payload",
      );
    }
    if (!options.encryption.isAvailable()) {
      throw credentialError(
        GATEWAY_CREDENTIALS_STORAGE_UNAVAILABLE,
        "safeStorage is unavailable; the gateway credentials cannot be decrypted",
      );
    }
    let plaintext: string;
    try {
      plaintext = options.encryption.decryptString(Buffer.from(payload, "base64"));
    } catch (error) {
      // Never fall back to an empty store: that would erase the Host identity.
      log("error", "gateway credential payload could not be decrypted", { file: filePath });
      throw credentialError(
        GATEWAY_CREDENTIALS_UNREADABLE,
        "the gateway credential payload could not be decrypted with this OS keychain",
        error,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (error) {
      throw credentialError(
        GATEWAY_CREDENTIALS_UNREADABLE,
        "the decrypted gateway credentials are not valid JSON",
        error,
      );
    }
    if (!isDocument(parsed)) {
      throw credentialError(
        GATEWAY_CREDENTIALS_UNREADABLE,
        "the decrypted gateway credentials have an unexpected shape",
      );
    }
    document = parsed;
  };

  const encrypt = (value: CredentialDocument): EncryptedEnvelope => {
    if (!options.encryption.isAvailable()) {
      throw credentialError(
        GATEWAY_CREDENTIALS_STORAGE_UNAVAILABLE,
        "safeStorage is unavailable; refusing to write gateway credentials in clear",
      );
    }
    return {
      version: 1,
      payload: options.encryption.encryptString(JSON.stringify(value)).toString("base64"),
    };
  };

  const persist = async (): Promise<void> => {
    const envelope = encrypt(loaded());
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Atomic replace: a crash leaves either the previous file or the new one.
    await rename(tmp, filePath);
  };

  const mutate = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const store: GatewayCredentialStore = {
    async open() {
      if (!opening) opening = load();
      await opening;
    },
    hostId() {
      return loaded().hostId;
    },
    enrolled() {
      return Boolean(loaded().credentials);
    },
    credentials() {
      return loaded().credentials;
    },
    saveCredentials(credentials) {
      return mutate(async () => {
        const current = loaded();
        document = { ...current, hostId: credentials.hostId, credentials };
        await persist();
      });
    },
    async findDeviceByTokenHash(tokenHash) {
      return loaded().devices.find((device) => device.tokenHash === tokenHash) ?? null;
    },
    saveDevice(record) {
      return mutate(async () => {
        const current = loaded();
        document = {
          ...current,
          devices: [...current.devices.filter((device) => device.deviceId !== record.deviceId), record],
        };
        await persist();
      });
    },
    touchDevice(deviceId, seenAt) {
      return mutate(async () => {
        const current = loaded();
        const device = current.devices.find((candidate) => candidate.deviceId === deviceId);
        if (!device) return;
        document = {
          ...current,
          devices: current.devices.map((candidate) =>
            candidate.deviceId === deviceId ? { ...candidate, lastSeenAt: seenAt } : candidate,
          ),
        };
        await persist();
      });
    },
    revokeDevice(deviceId, revokedAt) {
      return mutate(async () => {
        const current = loaded();
        const device = current.devices.find((candidate) => candidate.deviceId === deviceId);
        if (!device || device.revokedAt) return false;
        document = {
          ...current,
          devices: current.devices.map((candidate) =>
            candidate.deviceId === deviceId ? { ...candidate, revokedAt } : candidate,
          ),
        };
        await persist();
        return true;
      });
    },
    async listDevices() {
      return [...loaded().devices];
    },
    async findPairing(tokenHash) {
      return loaded().pairings.find((pairing) => pairing.tokenHash === tokenHash) ?? null;
    },
    savePairing(record) {
      return mutate(async () => {
        const current = loaded();
        document = {
          ...current,
          pairings: [
            ...current.pairings.filter((pairing) => pairing.tokenHash !== record.tokenHash),
            record,
          ],
        };
        await persist();
      });
    },
    consumePairing(tokenHash, consumedAt) {
      return mutate(async () => {
        const current = loaded();
        const pairing = current.pairings.find((candidate) => candidate.tokenHash === tokenHash);
        if (!pairing || pairing.consumedAt) return false;
        document = {
          ...current,
          pairings: current.pairings.map((candidate) =>
            candidate.tokenHash === tokenHash ? { ...candidate, consumedAt } : candidate,
          ),
        };
        await persist();
        return true;
      });
    },
  };
  return store;
}
