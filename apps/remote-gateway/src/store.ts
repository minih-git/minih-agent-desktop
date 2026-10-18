/**
 * Gateway file store (ADR 0330 §3.5): `--data-dir` holds the CA, the host and
 * device registries, the one-time enrollment codes, the audit log, and the
 * CSRF HMAC secret. Directory mode 0700, file mode 0600, every JSON write is
 * an atomic rename. No SQLite and no native dependency.
 *
 * The store holds no transcript, no provider secret, and no durable turn
 * command (S3): only identity records.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AuditLog, type AuditInput } from "./audit.js";

export type GatewayHostRecord = {
  hostId: string;
  label: string;
  /** PEM of the client certificate this Host authenticates the link with. */
  certificatePem: string;
  /** SHA-256 of the DER encoding, lowercase hex; the link compares it on every upgrade. */
  certificateFingerprint256: string;
  registeredAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type GatewayEnrollmentRecord = {
  /** SHA-256 of the one-time code; the code itself is never stored. */
  codeHash: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  hostId?: string;
};

export type GatewayDeviceRecord = {
  deviceId: string;
  hostId: string;
  label: string;
  /** SHA-256 of the device token; only the hash is ever stored (S8). */
  tokenHash: string;
  createdAt: string;
  revokedAt?: string;
};

type HostsFile = { hosts: GatewayHostRecord[] };
type EnrollmentsFile = { enrollments: GatewayEnrollmentRecord[] };
type DevicesFile = { devices: GatewayDeviceRecord[] };
type SecretFile = { secret: string; createdAt: string };

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
  if ((info.mode & 0o077) !== 0) {
    // Tighten a directory an operator created by hand, then re-check.
    await chmod(path, DIRECTORY_MODE);
    const tightened = await stat(path);
    if ((tightened.mode & 0o077) !== 0) throw new Error(`${path} must be accessible only by its owner`);
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await rename(temporary, path);
}

export class GatewayStore {
  readonly caDirectory: string;
  readonly caCertificatePath: string;
  readonly caKeyPath: string;
  readonly serverCertificatePath: string;
  readonly serverKeyPath: string;
  readonly secret: string;
  readonly audit: AuditLog;

  private hosts: GatewayHostRecord[] = [];
  private enrollments: GatewayEnrollmentRecord[] = [];
  private devices: GatewayDeviceRecord[] = [];
  private chain: Promise<void> = Promise.resolve();
  /** Audit appends still in flight, so shutdown can flush them. */
  private readonly pendingAudits = new Set<Promise<void>>();

  private constructor(
    readonly dataDir: string,
    secret: string,
    private readonly now: () => number,
  ) {
    this.caDirectory = join(dataDir, "ca");
    this.caCertificatePath = join(this.caDirectory, "ca.crt");
    this.caKeyPath = join(this.caDirectory, "ca.key");
    this.serverCertificatePath = join(this.caDirectory, "server.crt");
    this.serverKeyPath = join(this.caDirectory, "server.key");
    this.secret = secret;
    this.audit = new AuditLog(join(dataDir, "audit"), now);
  }

  /** Open (and on first start create) the data directory. */
  static async open(dataDir: string, now: () => number = () => Date.now()): Promise<GatewayStore> {
    await ensurePrivateDirectory(dataDir);
    await ensurePrivateDirectory(join(dataDir, "ca"));
    await ensurePrivateDirectory(join(dataDir, "audit"));
    const secretPath = join(dataDir, "gateway-secret");
    const existing = await readJson<SecretFile>(secretPath);
    let secret = existing?.secret;
    if (!secret || secret.length < 32) {
      secret = randomBytes(32).toString("base64url");
      await writeJsonAtomic(secretPath, { secret, createdAt: new Date(now()).toISOString() } satisfies SecretFile);
    }
    const store = new GatewayStore(dataDir, secret, now);
    store.hosts = (await readJson<HostsFile>(join(dataDir, "hosts.json")))?.hosts ?? [];
    store.enrollments = (await readJson<EnrollmentsFile>(join(dataDir, "enrollments.json")))?.enrollments ?? [];
    store.devices = (await readJson<DevicesFile>(join(dataDir, "devices.json")))?.devices ?? [];
    return store;
  }

  /** Serialize read-modify-write cycles so two requests cannot lose an update. */
  private mutate(operation: () => Promise<void>): Promise<void> {
    const run = this.chain.then(operation);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- hosts

  listHosts(): GatewayHostRecord[] {
    return [...this.hosts];
  }

  findHost(hostId: string): GatewayHostRecord | null {
    return this.hosts.find((host) => host.hostId === hostId) ?? null;
  }

  async saveHost(record: GatewayHostRecord): Promise<void> {
    await this.mutate(async () => {
      this.hosts = [...this.hosts.filter((host) => host.hostId !== record.hostId), record];
      await writeJsonAtomic(join(this.dataDir, "hosts.json"), { hosts: this.hosts } satisfies HostsFile);
    });
  }

  async touchHost(hostId: string, seenAt: string): Promise<void> {
    const host = this.findHost(hostId);
    if (!host) return;
    host.lastSeenAt = seenAt;
    await this.mutate(async () => {
      await writeJsonAtomic(join(this.dataDir, "hosts.json"), { hosts: this.hosts } satisfies HostsFile);
    });
  }

  async revokeHost(hostId: string, revokedAt: string): Promise<boolean> {
    let revoked = false;
    await this.mutate(async () => {
      this.hosts = this.hosts.map((host) => {
        if (host.hostId !== hostId || host.revokedAt) return host;
        revoked = true;
        return { ...host, revokedAt };
      });
      await writeJsonAtomic(join(this.dataDir, "hosts.json"), { hosts: this.hosts } satisfies HostsFile);
    });
    return revoked;
  }

  // ---------------------------------------------------------- enrollments

  async saveEnrollment(record: GatewayEnrollmentRecord): Promise<void> {
    await this.mutate(async () => {
      // Drop expired, unused codes; they are useless and should not accumulate.
      const now = this.now();
      this.enrollments = [
        ...this.enrollments.filter((enrollment) => !enrollment.usedAt && Date.parse(enrollment.expiresAt) > now),
        record,
      ];
      await writeJsonAtomic(join(this.dataDir, "enrollments.json"), { enrollments: this.enrollments } satisfies EnrollmentsFile);
    });
  }

  findEnrollment(codeHash: string): GatewayEnrollmentRecord | null {
    return this.enrollments.find((enrollment) => enrollment.codeHash === codeHash) ?? null;
  }

  async consumeEnrollment(codeHash: string, hostId: string, usedAt: string): Promise<boolean> {
    let consumed = false;
    await this.mutate(async () => {
      this.enrollments = this.enrollments.map((enrollment) => {
        if (enrollment.codeHash !== codeHash || enrollment.usedAt) return enrollment;
        consumed = true;
        return { ...enrollment, usedAt, hostId };
      });
      await writeJsonAtomic(join(this.dataDir, "enrollments.json"), { enrollments: this.enrollments } satisfies EnrollmentsFile);
    });
    return consumed;
  }

  // -------------------------------------------------------------- devices

  listDevices(): GatewayDeviceRecord[] {
    return [...this.devices];
  }

  findDevice(deviceId: string): GatewayDeviceRecord | null {
    return this.devices.find((device) => device.deviceId === deviceId) ?? null;
  }

  findDeviceByTokenHash(tokenHash: string): GatewayDeviceRecord | null {
    return this.devices.find((device) => device.tokenHash === tokenHash) ?? null;
  }

  async saveDevice(record: GatewayDeviceRecord): Promise<void> {
    await this.mutate(async () => {
      this.devices = [...this.devices.filter((device) => device.deviceId !== record.deviceId), record];
      await writeJsonAtomic(join(this.dataDir, "devices.json"), { devices: this.devices } satisfies DevicesFile);
    });
  }

  async revokeDevice(deviceId: string, revokedAt: string): Promise<boolean> {
    let revoked = false;
    await this.mutate(async () => {
      this.devices = this.devices.map((device) => {
        if (device.deviceId !== deviceId || device.revokedAt) return device;
        revoked = true;
        return { ...device, revokedAt };
      });
      await writeJsonAtomic(join(this.dataDir, "devices.json"), { devices: this.devices } satisfies DevicesFile);
    });
    return revoked;
  }

  // ---------------------------------------------------------------- audit

  async appendAudit(record: AuditInput): Promise<void> {
    const write = this.audit.append(record);
    this.pendingAudits.add(write);
    try {
      await write;
    } finally {
      this.pendingAudits.delete(write);
    }
  }

  /** Wait for every audit append that is still being written. */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingAudits]);
  }

  // ----------------------------------------------------------------- files

  async readCaFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeCaFile(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", mode: FILE_MODE });
    await rename(temporary, path);
  }
}
