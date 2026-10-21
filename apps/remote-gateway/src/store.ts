/**
 * Gateway file store (ADR 0331 §3.5): `--data-dir` holds the CA, the host and
 * device registries, the one-time enrollment codes, the account sessions, the
 * pending account-mode device grants and revocations, the audit log, and the
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
  /**
   * Router account this Host is enrolled under (protocol §11.5, D666). The
   * Router `access_key_id` as a decimal string. Absent means the Host came
   * through the self-hosted enrollment code and belongs to no account.
   */
  accountId?: string;
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
  /**
   * Account of an account-mode device (protocol §11.5, D666). A device minted
   * through the account flow reaches every Host of that account, so the
   * pre-routing fast reject matches on the account instead of on `hostId`.
   * Absent for a device paired with one Host through §11.4.
   */
  accountId?: string;
};

/**
 * One device's push registration (protocol §11.6, R5 PR-6). The provider token
 * is a secret: it is written with the store's usual 0600 mode, never returned by
 * a route, and never placed in an audit record.
 *
 * A §11.4 device is pushed about its own Host only; an account-mode device is
 * pushed about the Hosts of its account, and `hostIds` records the audience
 * captured at registration so a later Host enrollment cannot silently widen it.
 */
export type GatewayPushRegistrationRecord = {
  deviceId: string;
  /** Account of an account-mode device (§11.5); absent for a §11.4 device. */
  accountId?: string;
  /** The Host a §11.4 device paired with. */
  hostId: string;
  /** Every Host this registration covers, resolved at registration time. */
  hostIds: string[];
  platform: "ios" | "android";
  /** APNs device token or FCM registration token. */
  token: string;
  /** Optional app/bundle id, so one deployment can serve more than one build. */
  appId?: string;
  /**
   * "Only notify me about things that need me" (§17.6.5). Absent means every kind,
   * which is how every registration written before this field behaves.
   */
  onlyActionable?: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * One signed device grant the Gateway holds for an offline Host (§11.5
 * "Deferred grants", D666). The grant is durable so a Host that was down when
 * its sibling approved still adopts the device when its link comes up. The
 * record carries the signature and the signer's certificate, never the device
 * token: the token travels through the Gateway once, to the client that asked,
 * and is never written to disk.
 */
export type GatewayPendingGrantRecord = {
  grantId: string;
  requestId: string;
  accountId: string;
  signerHostId: string;
  deviceId: string;
  deviceLabel: string;
  /** SHA-256 of the device token, lowercase hex. */
  tokenHash: string;
  roles: string[];
  issuedAt: string;
  /**
   * The deadline the approving Host signed. It is relayed to the siblings
   * byte-for-byte, because it is part of the signed payload: rewriting it would
   * make every sibling refuse the grant.
   */
  deliverUntil: string;
  /**
   * When the GATEWAY stops offering this grant to a Host that has not taken it
   * yet. Deliberately not part of the signed payload, so the Gateway can bound
   * its own retention without touching what the Host signed.
   */
  relayUntil: string;
  signature: string;
  signerCertificate: string;
};

/**
 * One signed device revocation the Gateway holds for an account's Hosts
 * (§11.5, D666). A Host that was offline when its sibling revoked receives it
 * when its link comes up, so a lost device stops working everywhere.
 */
export type GatewayPendingRevocationRecord = {
  revokeId: string;
  accountId: string;
  signerHostId: string;
  deviceId: string;
  revokedAt: string;
  /** When the Gateway stops offering this revocation to a Host. */
  relayUntil: string;
  signature: string;
  signerCertificate: string;
};

/**
 * One account login (protocol §11.5, D666). The Router AccessKey is never
 * stored: only the hash of the session credential the Gateway minted from a
 * verified key, with a bounded lifetime. Revocation is server-side, so a
 * `revokedAt` record denies the credential for the rest of its lifetime.
 */
export type GatewayAccountSessionRecord = {
  sessionId: string;
  /** Router `access_key_id` of the account this session belongs to. */
  accountId: string;
  /** SHA-256 of the session credential; only the hash is ever stored. */
  tokenHash: string;
  /** Client-supplied label, for the operator reading the store. */
  label?: string;
  /**
   * Which client asked for this session (protocol §11.5). A browser session
   * receives the account device token as `HttpOnly` cookies scoped to each Host
   * of the account; a native session receives it in the response body for its
   * secure store. Absent on a session written before this field existed, which
   * is treated as non-browser.
   */
  client?: "web" | "ios" | "android";
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
};

type HostsFile = { hosts: GatewayHostRecord[] };
type EnrollmentsFile = { enrollments: GatewayEnrollmentRecord[] };
type DevicesFile = { devices: GatewayDeviceRecord[] };
type AccountSessionsFile = { accountSessions: GatewayAccountSessionRecord[] };
type DeviceGrantsFile = { deviceGrants: GatewayPendingGrantRecord[] };
type DeviceRevocationsFile = { deviceRevocations: GatewayPendingRevocationRecord[] };
type PushRegistrationsFile = { pushRegistrations: GatewayPushRegistrationRecord[] };
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
  private accountSessions: GatewayAccountSessionRecord[] = [];
  private deviceGrants: GatewayPendingGrantRecord[] = [];
  private deviceRevocations: GatewayPendingRevocationRecord[] = [];
  private pushRegistrations: GatewayPushRegistrationRecord[] = [];
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
    store.accountSessions = (await readJson<AccountSessionsFile>(join(dataDir, "account-sessions.json")))?.accountSessions ?? [];
    store.deviceGrants = (await readJson<DeviceGrantsFile>(join(dataDir, "device-grants.json")))?.deviceGrants ?? [];
    store.deviceRevocations =
      (await readJson<DeviceRevocationsFile>(join(dataDir, "device-revocations.json")))?.deviceRevocations ?? [];
    store.pushRegistrations =
      (await readJson<PushRegistrationsFile>(join(dataDir, "push-registrations.json")))?.pushRegistrations ?? [];
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

  /**
   * The Hosts of one account, revoked ones excluded (gate 29). The account host
   * list is built from this and never from `listHosts`, so a foreign Host can
   * neither appear nor be reached by id.
   */
  listHostsForAccount(accountId: string): GatewayHostRecord[] {
    return this.hosts.filter((host) => host.accountId === accountId && !host.revokedAt);
  }

  findHost(hostId: string): GatewayHostRecord | null {
    return this.hosts.find((host) => host.hostId === hostId) ?? null;
  }

  /**
   * Replace a Host record only when `guard` still accepts the record stored at
   * the moment of the write. The guard runs inside the same serialized mutation
   * as the write, so a concurrent revocation or an enrollment under another
   * account cannot be silently undone by this write (security gate 26, gate 29).
   * Returns whether the record was written.
   */
  async saveHostIfUnchanged(
    record: GatewayHostRecord,
    guard: (current: GatewayHostRecord | null) => boolean,
  ): Promise<boolean> {
    let saved = false;
    await this.mutate(async () => {
      if (!guard(this.findHost(record.hostId))) return;
      saved = true;
      this.hosts = [...this.hosts.filter((host) => host.hostId !== record.hostId), record];
      await writeJsonAtomic(join(this.dataDir, "hosts.json"), { hosts: this.hosts } satisfies HostsFile);
    });
    return saved;
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
      // A revoked device gets no notifications: the registration goes with it
      // (protocol §11.6), so a re-paired device starts from a clean slate.
      if (revoked) {
        this.pushRegistrations = this.pushRegistrations.filter((record) => record.deviceId !== deviceId);
        await writeJsonAtomic(join(this.dataDir, "push-registrations.json"), {
          pushRegistrations: this.pushRegistrations,
        } satisfies PushRegistrationsFile);
      }
      await writeJsonAtomic(join(this.dataDir, "devices.json"), { devices: this.devices } satisfies DevicesFile);
    });
    return revoked;
  }

  // ---------------------------------------------------- push registrations

  listPushRegistrations(): GatewayPushRegistrationRecord[] {
    return [...this.pushRegistrations];
  }

  findPushRegistration(deviceId: string): GatewayPushRegistrationRecord | null {
    return this.pushRegistrations.find((record) => record.deviceId === deviceId) ?? null;
  }

  /**
   * One registration per device: registering again replaces the old token.
   *
   * The device is re-checked *inside* the write, not before it: a registration
   * request reads its body first, and a revocation that lands while that read is
   * in flight must win. Returns false when the device is gone or revoked, so the
   * route answers `UNAUTHORIZED` instead of resurrecting a registration for a
   * device that was just taken away.
   */
  async savePushRegistration(record: GatewayPushRegistrationRecord): Promise<boolean> {
    let saved = false;
    await this.mutate(async () => {
      const device = this.devices.find((entry) => entry.deviceId === record.deviceId);
      if (!device || device.revokedAt) return;
      this.pushRegistrations = [...this.pushRegistrations.filter((entry) => entry.deviceId !== record.deviceId), record];
      await writeJsonAtomic(join(this.dataDir, "push-registrations.json"), {
        pushRegistrations: this.pushRegistrations,
      } satisfies PushRegistrationsFile);
      saved = true;
    });
    return saved;
  }

  /** `DELETE /v1/push/registration`, and the cleanup a revocation triggers. */
  async removePushRegistration(deviceId: string): Promise<boolean> {
    let removed = false;
    await this.mutate(async () => {
      const before = this.pushRegistrations.length;
      this.pushRegistrations = this.pushRegistrations.filter((record) => record.deviceId !== deviceId);
      removed = this.pushRegistrations.length !== before;
      if (removed) {
        await writeJsonAtomic(join(this.dataDir, "push-registrations.json"), {
          pushRegistrations: this.pushRegistrations,
        } satisfies PushRegistrationsFile);
      }
    });
    return removed;
  }

  /** A provider token the provider itself reported as dead. */
  async removePushRegistrationByToken(platform: "ios" | "android", token: string): Promise<number> {
    let removed = 0;
    await this.mutate(async () => {
      const before = this.pushRegistrations.length;
      this.pushRegistrations = this.pushRegistrations.filter(
        (record) => !(record.platform === platform && record.token === token),
      );
      removed = before - this.pushRegistrations.length;
      if (removed > 0) {
        await writeJsonAtomic(join(this.dataDir, "push-registrations.json"), {
          pushRegistrations: this.pushRegistrations,
        } satisfies PushRegistrationsFile);
      }
    });
    return removed;
  }

  // --------------------------------------------------- pending device grants
  /**
   * The grants still deliverable to one account's Hosts, expired ones dropped
   * on read so a stale grant is never relayed (gate 32).
   */
  listPendingGrants(accountId?: string): GatewayPendingGrantRecord[] {
    const now = this.now();
    return this.deviceGrants.filter(
      (grant) => Date.parse(grant.relayUntil) > now && (accountId === undefined || grant.accountId === accountId),
    );
  }

  async savePendingGrant(record: GatewayPendingGrantRecord): Promise<void> {
    await this.mutate(async () => {
      const now = this.now();
      this.deviceGrants = [
        ...this.deviceGrants.filter((grant) => grant.grantId !== record.grantId && Date.parse(grant.relayUntil) > now),
        record,
      ];
      await writeJsonAtomic(join(this.dataDir, "device-grants.json"), { deviceGrants: this.deviceGrants } satisfies DeviceGrantsFile);
    });
  }

  async deletePendingGrant(grantId: string): Promise<void> {
    await this.mutate(async () => {
      this.deviceGrants = this.deviceGrants.filter((grant) => grant.grantId !== grantId);
      await writeJsonAtomic(join(this.dataDir, "device-grants.json"), { deviceGrants: this.deviceGrants } satisfies DeviceGrantsFile);
    });
  }

  // ----------------------------------------------- pending device revocations
  /**
   * The revocations still deliverable to one account's Hosts. A revocation is
   * kept until its relay window closes, so a Host that was down when the device
   * was revoked still learns about it.
   */
  listPendingRevocations(accountId?: string): GatewayPendingRevocationRecord[] {
    const now = this.now();
    return this.deviceRevocations.filter(
      (revocation) => Date.parse(revocation.relayUntil) > now && (accountId === undefined || revocation.accountId === accountId),
    );
  }

  async savePendingRevocation(record: GatewayPendingRevocationRecord): Promise<void> {
    await this.mutate(async () => {
      const now = this.now();
      this.deviceRevocations = [
        ...this.deviceRevocations.filter(
          (revocation) => revocation.revokeId !== record.revokeId && Date.parse(revocation.relayUntil) > now,
        ),
        record,
      ];
      await writeJsonAtomic(join(this.dataDir, "device-revocations.json"), {
        deviceRevocations: this.deviceRevocations,
      } satisfies DeviceRevocationsFile);
    });
  }

  async deletePendingRevocation(revokeId: string): Promise<void> {
    await this.mutate(async () => {
      this.deviceRevocations = this.deviceRevocations.filter((revocation) => revocation.revokeId !== revokeId);
      await writeJsonAtomic(join(this.dataDir, "device-revocations.json"), {
        deviceRevocations: this.deviceRevocations,
      } satisfies DeviceRevocationsFile);
    });
  }

  // ------------------------------------------------------- account sessions

  findAccountSession(sessionId: string): GatewayAccountSessionRecord | null {
    return this.accountSessions.find((session) => session.sessionId === sessionId) ?? null;
  }

  findAccountSessionByTokenHash(tokenHash: string): GatewayAccountSessionRecord | null {
    return this.accountSessions.find((session) => session.tokenHash === tokenHash) ?? null;
  }

  /**
   * Account sessions that have not expired, optionally scoped to one account.
   * The stored hash is never part of the account-scoped view a caller sees; this
   * is the operator's and the tests' read path.
   */
  listAccountSessions(accountId?: string): GatewayAccountSessionRecord[] {
    const now = this.now();
    return this.accountSessions.filter(
      (session) => Date.parse(session.expiresAt) > now && (accountId === undefined || session.accountId === accountId),
    );
  }

  async saveAccountSession(record: GatewayAccountSessionRecord): Promise<void> {
    await this.mutate(async () => {
      // Drop expired sessions; they can no longer authenticate anything.
      const now = this.now();
      this.accountSessions = [
        ...this.accountSessions.filter((session) => Date.parse(session.expiresAt) > now),
        record,
      ];
      await writeJsonAtomic(join(this.dataDir, "account-sessions.json"), {
        accountSessions: this.accountSessions,
      } satisfies AccountSessionsFile);
    });
  }

  async revokeAccountSession(sessionId: string, revokedAt: string): Promise<boolean> {
    let revoked = false;
    await this.mutate(async () => {
      this.accountSessions = this.accountSessions.map((session) => {
        if (session.sessionId !== sessionId || session.revokedAt) return session;
        revoked = true;
        return { ...session, revokedAt };
      });
      await writeJsonAtomic(join(this.dataDir, "account-sessions.json"), {
        accountSessions: this.accountSessions,
      } satisfies AccountSessionsFile);
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
