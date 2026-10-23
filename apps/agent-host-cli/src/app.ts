import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentHost, type ApprovalPort } from "@minih-agent/agent-host";
import {
  AgentSidecar,
  HostProcess,
  PlanExecutionDispatcher,
  RuntimeService,
  RuntimeSupervisor,
  createHeadlessLaunchResolver,
  createHostQueueStore,
  createHostSessionPort,
  listPendingToolRequests,
} from "@minih-agent/host-runtime";
import {
  DeviceTokenAuthenticator,
  FileDeviceRevocationQueue,
  HostDeviceDirectory,
  RacpServer,
  bindRacpWebSocket,
  readCertificateAccountBinding,
  HostLinkNotifier,
  startHostLink,
  type HostLinkHandle,
  type RacpHostOperations,
  type WsBinding,
} from "@minih-agent/racp";
import { APP_VERSION, type AgentEventEnvelope } from "@minih-agent/shared";

import type { AgentHostCliConfig } from "./config.js";
import { FileCredentialStore, loadOrCreateHostId } from "./credentials.js";
import { readGatewayLink } from "./gateway-link.js";
import { AdminDeviceConfirmer } from "./device-confirmer.js";
import { createHostOperations } from "./host-operations.js";
import { createLogger, type HostLogger } from "./logger.js";
import { TerminalService, loadPty } from "./terminal.js";
import { prepareAdminDirectory, startAdminSocket } from "./admin-socket.js";

export type AgentHostCliApp = {
  hostId: string;
  address: { host: string; port: number };
  agentHost: AgentHost;
  runtime: RuntimeService;
  authenticator: DeviceTokenAuthenticator;
  server: RacpServer;
  log: HostLogger;
  /**
   * Mint a single-use pairing token for the bootstrap channel. The origin
   * fixes the only channel that can redeem it (security §3.7): `--pair` uses
   * `"ssh"`; `remote-pair` (PR-2) will pass `"gateway"`.
   */
  issuePairingToken(lifetimeMs: number, origin?: "ssh" | "gateway"): Promise<{ token: string; expiresAt: string }>;
  /**
   * Whether this Host advertises `device.confirm` (protocol §11.5). True only
   * when the device directory really exists, so an operator can tell a Host
   * that answers device requests from one the Gateway reports as unable to.
   */
  confirmDevices: boolean;
  /** ADR decision 9: this Host confirms every device and refuses sibling grants. */
  strictDevices: boolean;
  stop(): Promise<void>;
};

const APPROVAL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Compose the headless Host: host-core and the sidecar under the shared
 * supervisor, the runtime service as the module's runtime port, the Agent
 * Host module, and the RACP server on loopback. Everything the desktop
 * would own for a local session — transcript, queue, approvals, tools,
 * workspace — lives here on this machine.
 */
export async function startAgentHostCli(config: AgentHostCliConfig, options: { log?: HostLogger } = {}): Promise<AgentHostCliApp> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await prepareAdminDirectory(config.dataDir);
  const log = options.log ?? createLogger({ dataDir: config.dataDir, minLevel: config.logLevel });
  const hostId = await loadOrCreateHostId(config.dataDir);
  const store = new FileCredentialStore(config.dataDir);
  const authenticator = new DeviceTokenAuthenticator(store);
  // The outbound Host link needs its credentials before anything is spawned:
  // an unenrolled Host fails here, while it still owns no resources at all
  // (ADR 0331). A corrupt file reports its own `GATEWAY_LINK_INVALID` error.
  const gatewayCredentials = config.gateway ? await readGatewayLink(config.dataDir) : null;
  if (config.gateway && !gatewayCredentials) {
    throw Object.assign(new Error("this Host is not enrolled with a gateway; run `agent-host-cli enroll` first"), {
      errorCode: "GATEWAY_LINK_MISSING",
    });
  }

  // Declared before the admin socket opens, so a device operation that arrives
  // while the app is still starting never touches an uninitialised binding.
  let server: RacpServer | null = null;
  let hostLink: HostLinkHandle | null = null;

  /**
   * Revoke one device: sign and queue the frame that tells the account's other
   * Hosts (§11.5, ADR decision 6), then close this Host's live connections for
   * that subject. The local revocation happens either way, and a frame that
   * cannot go out now waits in the queue for the next link — so `announced`
   * reports what really left the process and never overstates it. Without an
   * account-mode directory this is the plain local revocation of §11.4.
   */
  const revokeDevice = async (deviceId: string): Promise<{ revoked: boolean; announced: boolean }> => {
    const outcome = (await hostLink?.revokeDevice(deviceId)) ?? { revoked: false, announced: false };
    const revoked = outcome.revoked || (await store.revokeDevice(deviceId, new Date().toISOString()));
    if (revoked) {
      const closed = server?.closeConnectionsForSubject(deviceId, "device revoked") ?? 0;
      log("info", "device revoked", { deviceId, closedConnections: closed, announced: outcome.announced });
    }
    return { revoked, announced: outcome.announced };
  };

  /**
   * The account-mode device directory (§11.5, D666). It exists only when the
   * Host can actually answer: `--gateway` on, an account-bound certificate,
   * `--confirm-devices` (or `--strict-devices`) on, and a platform with the
   * owner-only admin socket. Otherwise this Host advertises nothing, and the
   * Gateway reports it to the client as unable to confirm rather than leaving
   * the client waiting (security gate 33).
   */
  let confirmer: AdminDeviceConfirmer | null = null;
  let devices: HostDeviceDirectory | null = null;
  let revocations: FileDeviceRevocationQueue | null = null;
  if (gatewayCredentials && (config.confirmDevices || config.strictDevices)) {
    if (process.platform === "win32") {
      log("warn", "device confirmation needs the admin socket; it is unavailable on Windows");
    } else if (!readCertificateAccountBinding(gatewayCredentials.certificatePem)) {
      log("warn", "this Host certificate carries no account binding; device confirmation is off");
    } else {
      confirmer = new AdminDeviceConfirmer((level, message, data) => log(level, message, data));
      devices = new HostDeviceDirectory({
        hostId: gatewayCredentials.hostId,
        signer: { certificatePem: gatewayCredentials.certificatePem, privateKeyPem: gatewayCredentials.privateKeyPem },
        gatewayCaPem: gatewayCredentials.gatewayCaPem,
        store,
        log: (level, message, data) => log(level, message, data),
        confirmer,
        strictMode: config.strictDevices,
        desktopAutoAdmission: config.desktopAuto,
        onNotice: (notice) => log("info", `device ${notice.kind}`, { deviceId: notice.deviceId, label: notice.label }),
      });
      // A revocation made while the link is down waits here and is re-offered
      // on the next link, so a lost device stops working everywhere even if the
      // user revokes it while this Host is offline.
      revocations = new FileDeviceRevocationQueue(join(config.dataDir, "agent-host-cli", "device-revocations.json"));
    }
  }

  const state: { host: HostProcess | null; sidecar: AgentSidecar | null; stopping: boolean } = { host: null, sidecar: null, stopping: false };
  const getHost = () => state.host;
  const getSidecar = () => state.sidecar;

  const launch = createHeadlessLaunchResolver({ getHost, dataDir: config.dataDir, log: (level, message, data) => log(level, message, data) });
  const runtime = new RuntimeService({ getHost, getSidecar, launch, log });

  const approvals: ApprovalPort = {
    async resolveTool(requestId, decision) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      await host.call("permissions.resolve", { requestId, decision });
    },
    async resolveContract(input) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const pending = await host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>("plans.pending", { sessionId: input.sessionId });
      const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
      if (!proposal) throw Object.assign(new Error(`proposal ${input.proposalId} is not pending`), { errorCode: "NOT_FOUND" });
      const result = await host.call("plans.resolve", {
        proposalId: input.proposalId,
        sessionId: input.sessionId,
        turnId: proposal.turnId ?? "",
        toolCallId: proposal.toolCallId ?? "",
        action: input.action,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
      });
      if (input.action === "approve") void plans.dispatchExecutionForProposal(input.proposalId);
      return void result;
    },
    listPendingTools: (sessionId) => listPendingToolRequests(getHost, sessionId),
  };
  // Redacted push (§11.6): the Host reports the four notification-worthy events
  // and the Gateway decides who hears about them. The notifier holds the sender
  // of the current link, so a notification is never written to a dead socket.
  const notifier = new HostLinkNotifier({ log: (level, message, data) => log(level, message, data) });
  const agentHost = new AgentHost({
    runtime,
    sessions: createHostSessionPort(getHost),
    approvals,
    queueStore: createHostQueueStore(getHost),
    localApprovalLifetimeMs: APPROVAL_REQUEST_TIMEOUT_MS,
    onNotifyEvent: (event) => {
      notifier.notify(event);
    },
  });
  const plans = new PlanExecutionDispatcher({ getHost, getSidecar, launch, runtime, log });

  // Every runtime event feeds the module; a settled turn closes it there too.
  const abortingSessions = new Set<string>();
  runtime.onEvent((envelope: AgentEventEnvelope) => {
    const interrupted = envelope.event.type === "agent_end" && abortingSessions.has(envelope.sessionId);
    if (envelope.event.type === "agent_end" || envelope.event.type === "error") abortingSessions.delete(envelope.sessionId);
    try {
      agentHost.ingest(envelope, { interrupted });
    } catch (error) {
      log("warn", "agent host ingest failed", { sessionId: envelope.sessionId, type: envelope.event.type, error: String(error) });
    }
  });
  runtime.onTurnEnded((info) => {
    abortingSessions.delete(info.sessionId);
    const status = info.reason === "aborted" ? "interrupted" : info.reason === "error" ? "failed" : "completed";
    try {
      agentHost.endTurn(info.sessionId, info.turnId, status, info.errorCode ? { error: { code: info.errorCode, message: info.errorCode, retriable: false, traceId: "" } } : {});
      agentHost.kick(info.sessionId);
    } catch (error) {
      log("warn", "agent host end turn failed", { sessionId: info.sessionId, turnId: info.turnId, error: String(error) });
    }
  });
  const originalAbort = runtime.abort.bind(runtime);
  runtime.abort = async (sessionId, turnId) => {
    abortingSessions.add(sessionId);
    try {
      await originalAbort(sessionId, turnId);
    } catch (error) {
      abortingSessions.delete(sessionId);
      throw error;
    }
  };

  const startHost = async () => {
    const host = new HostProcess({ binaryPath: config.hostCoreBinary, dataDir: config.dataDir, onStderr: log.child("host") });
    host.onExit(({ intentional }) => {
      if (state.host !== host) return;
      state.host = null;
      if (intentional || state.stopping) return;
      log("error", "host-core exited unexpectedly");
      void supervisor.superviseRestart("host");
    });
    state.host = host;
    try {
      await host.handshake();
      await host.call("session.recoverInflightMessages").catch((error: unknown) => log("warn", "in-flight recovery failed", { error: String(error) }));
    } catch (error) {
      if (state.host === host) state.host = null;
      await host.dispose();
      throw error;
    }
    runtime.attachHost(host);
    state.sidecar?.setHost(host);
    log("info", "host-core handshake ok", { generation: host.generation });
  };
  const startSidecar = async () => {
    const sidecar = new AgentSidecar({
      launch: { command: config.nodeBinary, args: [config.sidecarEntry], env: { ...process.env, MINIH_AGENT_DATA_DIR: config.dataDir } },
      onStderr: log.child("agent"),
    });
    sidecar.onExit(({ intentional, code, signal, stderrTail }) => {
      if (state.sidecar !== sidecar) return;
      state.sidecar = null;
      if (intentional || state.stopping) return;
      log("error", "agent sidecar exited unexpectedly", { exitCode: code, signal, stderrTail });
      void supervisor.superviseRestart("sidecar");
    });
    sidecar.setProjectInstructionResolver(async ({ projectPath, path }) => {
      const { loadInstructionChain } = await import("@minih-agent/agent-runtime");
      return loadInstructionChain(projectPath, path);
    });
    sidecar.setLocalTool("Skill", async ({ args, sessionId }) => {
      const id = String((args as { id?: unknown })?.id ?? "").trim();
      const host = getHost();
      if (!id || !host) return { ok: false, isError: true, content: "Skill: `id` is required." };
      const session = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(() => null);
      const result = await host.call<{ skill: { id: string; name: string } | null; body: string | null }>("skills.read", { id, projectPath: session?.session?.projectPath ?? null }).catch(() => null);
      if (!result?.skill || typeof result.body !== "string") return { ok: false, isError: true, content: `Skill: "${id}" is not available on this Host.` };
      return { ok: true, content: `# Skill: ${result.skill.name} (${result.skill.id})\n\n${result.body}` };
    });
    sidecar.setTrustedExtensionBridge({
      publishCommands: () => undefined,
      publishDiagnostics: () => undefined,
      requestUi: async () => {
        throw new Error("extension UI is not available on a headless host");
      },
      configureModel: async () => {
        throw new Error("extension model configuration is not available on a headless host");
      },
      queuePush: async (params) =>
        agentHost.startTurn({ subject: "extension", roles: ["controller"] }, {
          sessionId: String(params.sessionId ?? ""),
          admission: "queue",
          input: { text: String(params.content ?? "") },
          context: { requestId: `ext-${Date.now().toString(36)}`, ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}) },
        }),
      queuePrioritize: async (params) => agentHost.prioritizeTurn({ subject: "extension", roles: ["controller"] }, String(params.id ?? "")),
    });
    state.sidecar = sidecar;
    runtime.attachSidecar(sidecar);
    if (state.host) sidecar.setHost(state.host);
    await sidecar.call("sidecar.configure", { hostBinary: config.hostCoreBinary, dataDir: config.dataDir });
    log("info", "agent sidecar configured");
  };
  const supervisor = new RuntimeSupervisor({
    start: { host: startHost, sidecar: startSidecar },
    afterRestart: () => plans.drainApprovedPlanExecutions(),
    isShuttingDown: () => state.stopping,
    onEvent: (event) => {
      if (event.phase === "fatal") log("error", `${event.kind} restart gave up`, { reason: event.reason, error: event.error ? String(event.error) : undefined });
      else if (event.phase === "restarted") log("warn", `${event.kind} restarted after crash`, { attempt: event.attempt });
      else if (event.phase === "restart_failed") log("error", `${event.kind} restart failed`, { attempt: event.attempt, error: String(event.error) });
    },
  });

  // Claim the owner-only channel before spawning the sole SQLite writer.
  // `remote-pair` mints a gateway-origin code on the running instance: the code
  // is redeemable only over the Host link, never through the SSH channel.
  const admin = process.platform === "win32"
    ? undefined
    : await startAdminSocket({
        dataDir: config.dataDir,
        getHost,
        issuePairingToken: (lifetimeMs) => authenticator.issuePairingToken(lifetimeMs, "gateway"),
        ...(confirmer
          ? {
              devices: {
                pending: () => confirmer!.pending(),
                // The admin vocabulary is imperative; the directory's is not.
                decide: (requestId: string, decision: "approve" | "deny") =>
                  confirmer!.decide(requestId, decision === "approve" ? "approved" : "denied"),
                revoke: revokeDevice,
              },
            }
          : {}),
        log,
      });
  try {
    await startHost();
    await startSidecar();
    await agentHost.start();
    await plans.drainApprovedPlanExecutions().catch((error: unknown) => log("warn", "queued approved plan drain failed", { error: String(error) }));
  } catch (error) {
    state.stopping = true;
    await admin?.close();
    plans.dispose();
    await runtime.dispose();
    await state.sidecar?.dispose();
    await state.host?.dispose();
    throw error;
  }

  const pty = loadPty();
  const terminal = pty
    ? new TerminalService({
        pty,
        log,
        sessionRoot: async (sessionId) => {
          const host = getHost();
          if (!host) throw new Error("host unavailable");
          const result = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 });
          const root = result.session?.projectPath?.trim();
          if (!root) throw Object.assign(new Error("the session has no project root"), { errorCode: "CONFLICT" });
          return root;
        },
      })
    : undefined;
  if (!pty) log("warn", "node-pty is not installed; terminals are disabled");

  const operations: RacpHostOperations = {
    ...createHostOperations({
      getHost,
      dataDir: config.dataDir,
      runtime,
      browseRoot: config.browseRoot,
      logRemoteAction: (info) => log("info", `remote device ${info.kind}`, {
        deviceId: info.deviceId,
        ...(info.sessionId ? { sessionId: info.sessionId } : {}),
        ...(info.changes ? { changes: info.changes } : {}),
      }),
      disposeSession: async (sessionId) => {
        const sidecar = getSidecar();
        if (!sidecar) return;
        sidecar.clearProjectInstructionRoot(sessionId);
        await sidecar.call("agent.disposeSession", { sessionId }).catch(() => undefined);
      },
      // The RACP operation answers whether the device was revoked here; the
      // announcement to the account's other Hosts is queued separately.
      revokeDevice: async (deviceId) => (await revokeDevice(deviceId)).revoked,
    }),
    ...(terminal ? { terminal } : {}),
  };
  server = new RacpServer({
    agentHost,
    operations,
    authenticator,
    hostId,
    serverVersion: APP_VERSION,
    log,
    // Opt-in P0 measurement; the logging spec forbids a per-request timing
    // stream in a normal run, so this is off unless explicitly requested.
    latencyTrace: process.env.MINIH_REMOTE_LATENCY_TRACE === "1",
  });
  let binding: WsBinding;
  try {
    binding = await bindRacpWebSocket({ server, authenticator, host: config.host, port: config.port, log });
  } catch (error) {
    state.stopping = true;
    await admin?.close();
    server.close();
    await terminal?.closeAll();
    plans.dispose();
    await runtime.dispose();
    await state.sidecar?.dispose();
    await state.host?.dispose();
    throw error;
  }
  // The opt-in outbound Host link (ADR 0331). Its credentials were read before
  // the first subprocess started; the loopback listener, `--pair`, and the SSH
  // bootstrap are unchanged when `--gateway` stays off.
  if (gatewayCredentials) {
    hostLink = startHostLink({
      credentials: gatewayCredentials,
      server,
      authenticator,
      log: (level, message, data) => log(level, message, data),
      devices,
      revocations,
      notifier,
      // "A new computer joined the account" is information for the person who
      // owns the account: it is logged here so a headless Host's operator sees
      // the attacker's first step even though this Host has no window to show
      // it in (ADR amendment 3, Accepted risk).
      onHostJoined: (notice) => log("info", "a new computer joined the account", { hostId: notice.hostId, label: notice.label }),
      onStatus: (status) => log("info", "gateway link status", { state: status.state, since: status.since }),
    });
  }
  log("info", "agent-host-cli ready", {
    hostId,
    host: binding.address.host,
    port: binding.address.port,
    version: APP_VERSION,
    terminal: Boolean(terminal),
    gateway: config.gateway,
    confirmDevices: Boolean(devices),
    strictDevices: devices?.isStrict ?? false,
  });

  return {
    hostId,
    address: binding.address,
    agentHost,
    runtime,
    authenticator,
    server,
    log,
    issuePairingToken: (lifetimeMs, origin) => authenticator.issuePairingToken(lifetimeMs, origin),
    confirmDevices: Boolean(devices),
    strictDevices: devices?.isStrict ?? false,
    async stop() {
      if (state.stopping) return;
      state.stopping = true;
      log("info", "agent-host-cli stopping");
      await admin?.close();
      // Nobody can answer a pending request once this Host is going away.
      confirmer?.close();
      await hostLink?.stop();
      server.close();
      await binding.close();
      await terminal?.closeAll();
      plans.dispose();
      await runtime.dispose();
      await state.sidecar?.dispose();
      await state.host?.dispose();
      state.sidecar = null;
      state.host = null;
    },
  };
}
