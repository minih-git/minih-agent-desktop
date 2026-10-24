/**
 * Orchestrates one built-in title generation: ask the host whether the session
 * is still auto-title eligible, pick a model, run a one-shot completion, and
 * compare-and-set the title through the host.
 *
 * Kept separate from `agent-ipc.ts` so the flow is unit-testable with fake
 * ports. Fire-and-forget by contract: `run` resolves to `false` for every
 * skipped or failed case and never throws, so the send path can detach it
 * without a rejection handler.
 */

import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import {
  promptReferenceFileNames,
  promptTextWithoutReferences,
  type AppSettings,
} from "@minih-agent/shared";
import type { Context } from "@earendil-works/pi-ai";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "./oauth";
import type { Logger } from "./logger";
import {
  buildSessionRetitleRequest,
  buildSessionTitleRequest,
  normalizeGeneratedTitle,
  summaryFingerprint,
  type SessionTitleModel,
  type SessionTitleRequest,
} from "./session-title-engine";
import { readPastedPromptMaterial } from "./session-title-input";

import type { RuntimeModelResolver, RuntimeModelOverrides } from "./runtime/model-resolution";

export type SessionTitleDeps = {
  getHost: () => { call: (method: string, params?: unknown) => Promise<unknown> } | null;
  resolveRuntimeModel: RuntimeModelResolver;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
  logger: Pick<Logger, "app">;
  /** Host data directory; pasted prompt material lives under its scratch root. */
  dataDir?: string;
  /**
   * Runs after a title write landed, so the renderer can refresh the session
   * list: without it a generated name stayed invisible until the next reload.
   */
  onTitleChanged?: (sessionId: string) => void;
  /** Guard against two generations racing on the same session. */
  inFlight?: Set<string>;
  /** Running compositions, so a later trigger can wait for one. */
  runRegistry?: Map<string, Promise<boolean>>;
  /** Injectable completion for tests; production uses the runtime default. */
  completeOneShot?: typeof completeOneShotImpl;
};

/** One generation's trigger, read by the caller at send time. */
export type SessionTitleJob = {
  sessionId: string;
  /**
   * The session's launch identity, used to resolve the title model. A caller
   * that does not have it (a settled-turn retry) passes an empty object and the
   * request's own model key still decides the provider.
   */
  session: {
    providerId?: string;
    modelId?: string;
  } | null | undefined;
  settings: AppSettings | null | undefined;
};

/**
 * The built-in generator: one instance per process, shared by the send path
 * and the settled-turn retry so both serialize on the same run registry.
 */
export type SessionTitleGenerator = {
  /** Compose and write one title. `false` for any skip or failure. */
  run: (job: SessionTitleJob) => Promise<boolean>;
  /** Whether a composition is running for this session right now. */
  isRunning: (sessionId: string) => boolean;
  /**
   * Resolve with the outcome of the running composition, or `undefined` when
   * nothing was running. Lets a later trigger wait instead of skipping: a
   * generation that fails after its turn ended must still be retryable.
   */
  whenIdle: (sessionId: string) => Promise<boolean | undefined>;
};

const inFlightSessions = new Set<string>();
/** Running compositions by session, so a later trigger can wait for one. */
const runningCompositions = new Map<string, Promise<boolean>>();

/** The `providerId/modelId` a request will complete against. */
function splitModelKey(modelKey: string): { providerId: string; modelId: string } | null {
  const separator = modelKey.indexOf("/");
  if (separator <= 0 || separator === modelKey.length - 1) return null;
  return {
    providerId: modelKey.slice(0, separator),
    modelId: modelKey.slice(separator + 1),
  };
}

/**
 * Launch overrides for one composition.
 *
 * The requested model always decides the provider: leaving the override out
 * made the resolver fall back to the default provider whenever the caller had
 * no session binding (the settled-turn retry), so the pasted text was sent to
 * a service the request never named. Only an explicit session identity that
 * equals the requested model keeps the session's own launch.
 */
export function titleLaunchOverrides(
  request: SessionTitleRequest,
  session: SessionTitleJob["session"],
): RuntimeModelOverrides {
  const sessionKey =
    session?.providerId && session?.modelId
      ? `${session.providerId}/${session.modelId}`
      : "";
  const parts = sessionKey === request.modelKey ? null : splitModelKey(request.modelKey);
  return {
    ...(parts ?? {}),
    thinkingLevel: request.thinkingLevel,
  };
}

/**
 * Read the providers a title completion may use, without credentials: the
 * ready check mirrors `listReadyPluginModels`, and bindings flatten to
 * `providerId/modelId` keys with their advertised thinking levels.
 */
export function sessionTitleModelsFromProviders(
  providers: Array<Record<string, unknown>> | undefined,
): SessionTitleModel[] {
  const models: SessionTitleModel[] = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!provider || provider.enabled === false) continue;
    const ready =
      provider.hasSecret === true || provider.hasOauth === true || provider.authKind === "none";
    if (!ready) continue;
    const bindings: unknown[] = Array.isArray(provider.models)
      ? provider.models
      : typeof provider.defaultModelId === "string" && provider.defaultModelId
        ? [{ id: provider.defaultModelId }]
        : [];
    for (const binding of bindings) {
      const modelId = String((binding as { id?: unknown })?.id ?? "").trim();
      if (!modelId) continue;
      const levels = (binding as { thinkingLevels?: unknown })?.thinkingLevels;
      models.push({
        key: `${String(provider.id)}/${modelId}`,
        ...(Array.isArray(levels)
          ? { thinkingLevels: levels.filter((level): level is string => typeof level === "string") }
          : {}),
      });
    }
  }
  return models;
}

async function resolveTitleProvider(
  deps: SessionTitleDeps,
  job: SessionTitleJob,
  request: SessionTitleRequest,
): Promise<RuntimeProviderConfig | null> {
  const model = await deps.resolveRuntimeModel(
    job.session ?? {},
    job.settings ?? {},
    titleLaunchOverrides(request, job.session),
  );
  return {
    ...model.provider,
    ...(model.provider.authKind === OAUTH_AUTH_KIND
      ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(model.providerId) }
      : {}),
  } as RuntimeProviderConfig;
}

async function completeTitle(
  deps: SessionTitleDeps,
  provider: RuntimeProviderConfig,
  request: SessionTitleRequest,
  sessionId: string,
): Promise<string> {
  const result = await (deps.completeOneShot ?? completeOneShotImpl)(
    provider,
    {
      systemPrompt: request.system,
      messages: [{ role: "user", content: request.userContent, timestamp: Date.now() }],
    } as Context,
    request.thinkingLevel,
    { sessionId, maxOutputTokens: 128 },
  );
  return normalizeGeneratedTitle(result?.text);
}

/**
 * Compose a title for `sessionId` from its first persisted user message.
 *
 * Gate order matters: the settings gate runs first so a disabled feature costs
 * nothing, and `session.autoTitleContext` is the once-only gate — it answers
 * nothing once a manual or generated title owns the session, so no later
 * message ever renames it again and no wasted model call is made. The naming
 * input is always the first persisted user message, and the host CAS stays the
 * final arbiter: the write lands only while the expected title is still
 * current, so a manual rename always wins.
 */
async function composeSessionTitle(
  deps: SessionTitleDeps,
  job: SessionTitleJob,
  sessionId: string,
): Promise<boolean> {
  const host = deps.getHost();
  if (!host) return false;
  const settingsTitle = job.settings?.sessionTitle;
  const preferredModelKey = String(settingsTitle?.modelKey ?? "").trim();

  try {
    // One host round-trip decides everything: null means the session already
    // carries a manual or generated title (or has no first message yet), so
    // the session is left untouched and no model call is spent.
    const context = (await host.call("session.autoTitleContext", {
      id: sessionId,
    })) as {
      expectedTitle: string;
      userPrompt: string;
      modelKey?: string;
    } | null;
    const expectedTitle = String(context?.expectedTitle ?? "");
    if (!context || !expectedTitle.trim()) return false;

    // The chip in the first message is a path, so the naming input is the
    // user's own words plus the bounded text that path points at. Both stay
    // inside this session: only its own `pasted/` directory is readable.
    const pastedMaterial = deps.dataDir
      ? await readPastedPromptMaterial({
          dataDir: deps.dataDir,
          sessionId,
          prompt: context.userPrompt,
        })
      : "";
    const userPrompt = promptTextWithoutReferences(context.userPrompt);
    // A prompt that only references workspace files still says what the session
    // is about (`@src/login.ts`), so the names travel as naming context instead
    // of leaving an empty input and no title at all.
    const referencedFiles = promptReferenceFileNames(context.userPrompt);
    // A listed model set doubles as the "is a provider ready" check: an
    // empty list means no usable provider, and no call is attempted.
    const listed = (await host.call("providers.list", {
      includeDisabled: false,
    })) as { providers?: Array<Record<string, unknown>> } | undefined;
    const request = buildSessionTitleRequest({
      preferredModelKey: preferredModelKey || undefined,
      sessionModelKey: context.modelKey ?? null,
      thinkingLevel: settingsTitle?.thinkingLevel,
      models: sessionTitleModelsFromProviders(listed?.providers),
      userPrompt,
      pastedMaterial,
      referencedFiles,
    });
    if (!request) return false;

    const provider = await resolveTitleProvider(deps, job, request);
    if (!provider) return false;
    const title = await completeTitle(deps, provider, request, sessionId);
    if (!title) return false;
    // The host refuses anything but the expected still-fallback title, so a
    // manual rename or a faster generated title always wins this write.
    const written = (await host.call("session.autoTitle", {
      id: sessionId,
      expectedTitle,
      title,
    })) as { updated?: boolean } | undefined;
    if (written?.updated === true) {
      deps.logger.app("session", "info", "session title generated", {
        sessionId,
        data: { modelKey: request.modelKey, pastedMaterial: Boolean(pastedMaterial) },
      });
      // The name is durable now; the sidebar only learns about it here.
      deps.onTitleChanged?.(sessionId);
    }
    return written?.updated === true;
  } catch (error) {
    deps.logger.app("session", "warn", "session title generation failed", {
      sessionId,
      data: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Register the composition before its first await and release it afterwards.
 *
 * The reservation has to happen synchronously: two triggers that both read the
 * guard before either registered one ran a second completion for the same
 * session, which is exactly the duplicate the guard exists to prevent.
 */
function startComposition(
  deps: SessionTitleDeps,
  job: SessionTitleJob,
  sessionId: string,
): Promise<boolean> {
  const guard = deps.inFlight ?? inFlightSessions;
  const runs = deps.runRegistry ?? runningCompositions;
  const promise = composeSessionTitle(deps, job, sessionId);
  guard.add(sessionId);
  runs.set(sessionId, promise);
  return promise.finally(() => {
    if (runs.get(sessionId) === promise) runs.delete(sessionId);
    guard.delete(sessionId);
  });
}

/**
 * Generate a title for `sessionId` from its first persisted user message.
 * Resolves `false` without doing anything when another composition already
 * owns the session, or when the feature is off, the session is native, or the
 * host is unavailable.
 */
export async function generateSessionTitle(
  deps: SessionTitleDeps,
  job: SessionTitleJob,
): Promise<boolean> {
  const sessionId = job.sessionId.trim();
  if (!sessionId || sessionId.startsWith("native-pi:")) return false;
  if (job.settings?.sessionTitle?.enabled === false) return false;
  if (!deps.getHost()) return false;
  if ((deps.inFlight ?? inFlightSessions).has(sessionId)) return false;
  return startComposition(deps, job, sessionId);
}

/** The one generator instance the IPC and retry paths wire in. */
export function createSessionTitleGenerator(deps: SessionTitleDeps): SessionTitleGenerator {
  return {
    run: (job) => generateSessionTitle(deps, job),
    isRunning: (sessionId) => (deps.inFlight ?? inFlightSessions).has(sessionId),
    whenIdle: async (sessionId) => {
      const running = (deps.runRegistry ?? runningCompositions).get(sessionId);
      if (!running) return undefined;
      // A failed composition already logged itself; the waiter only needs the
      // outcome, never a rejection it would have to swallow silently.
      return running.catch(() => false);
    },
  };
}

/** One post-compaction re-title job, read by the compaction event listener. */
export type SessionRetitleJob = {
  sessionId: string;
  /** Fingerprint of the summary at trigger time; stale events are dropped. */
  summaryFingerprint: string;
  settings: AppSettings | null | undefined;
};

/**
 * The summary fingerprint a runtime event should re-title from, or `undefined`
 * when it should not trigger a re-title at all.
 *
 * Only a persisted, summarized checkpoint qualifies. A `model_switch`
 * checkpoint is excluded: it summarizes the same conversation for another
 * model, so the subject the title names has not moved, and re-titling would
 * spend a model request on a cost optimization.
 */
export function retitleFingerprintForCompaction(event: {
  type: string;
  ok?: boolean;
  reason?: string;
  summaryFingerprint?: unknown;
}): string | undefined {
  if (event.type !== "compaction_end" || event.ok !== true) return undefined;
  if (event.reason === "model_switch") return undefined;
  return typeof event.summaryFingerprint === "string"
    ? event.summaryFingerprint
    : undefined;
}

/**
 * Re-title a session from its latest compaction summary.
 *
 * Fired after a compaction persists (`compaction_end`): the conversation's
 * subject may have drifted, and the summary is the best naming input. The
 * host's retitle context gates the call — a manual rename answers nothing —
 * and the compare-and-set write replaces only a `default` or `generated`
 * title, so a user's own name always survives. Fire-and-forget by contract:
 * resolves to `false` for every skipped or failed case and never throws.
 */
export async function generateSessionRetitle(
  deps: SessionTitleDeps,
  job: SessionRetitleJob,
): Promise<boolean> {
  const sessionId = job.sessionId.trim();
  if (!sessionId || sessionId.startsWith("native-pi:")) return false;
  if (job.settings?.sessionTitle?.enabled === false) return false;
  if (!job.summaryFingerprint.trim()) return false;

  const host = deps.getHost();
  if (!host) return false;
  const guard = deps.inFlight ?? inFlightSessions;
  if (guard.has(sessionId)) return false;

  const settingsTitle = job.settings?.sessionTitle;
  const preferredModelKey = String(settingsTitle?.modelKey ?? "").trim();
  // The session is not the launch identity here, so the request's own model
  // key must decide the provider; see `titleLaunchOverrides`.
  const retitleJob: SessionTitleJob = { sessionId, session: {}, settings: job.settings };

  try {
    // Null means the session carries a manual rename (or is gone): the user's
    // title wins forever and no model call is spent.
    const context = (await host.call("session.retitleContext", {
      id: sessionId,
    })) as {
      expectedTitle: string;
      modelKey?: string;
    } | null;
    const expectedTitle = String(context?.expectedTitle ?? "");
    if (!context || !expectedTitle.trim()) return false;

    // The checkpoint may have been superseded between the event and this
    // read; only the summary that is still current names the session.
    const compactions = (await host.call("session.get", {
      id: sessionId,
      messageLimit: 1,
    })) as { session?: { compaction?: { summary?: unknown } | null } } | undefined;
    const summary = String(compactions?.session?.compaction?.summary ?? "");
    if (summaryFingerprint(summary) !== job.summaryFingerprint) return false;

    const listed = (await host.call("providers.list", {
      includeDisabled: false,
    })) as { providers?: Array<Record<string, unknown>> } | undefined;
    const request = buildSessionRetitleRequest({
      preferredModelKey: preferredModelKey || undefined,
      sessionModelKey: context.modelKey ?? null,
      thinkingLevel: settingsTitle?.thinkingLevel,
      models: sessionTitleModelsFromProviders(listed?.providers),
      summary,
      // The checkpoint may be summarized in another language; the replacement
      // keeps the language the session is already named in.
      currentTitle: expectedTitle,
    });
    if (!request) return false;

    const provider = await resolveTitleProvider(deps, retitleJob, request);
    if (!provider) return false;
    const title = await completeTitle(deps, provider, request, sessionId);
    if (!title || title === expectedTitle) return false;
    // The host replaces only a default/generated title, so a manual rename
    // always wins and two racing generations serialize on the CAS.
    const written = (await host.call("session.retitleFromCompaction", {
      id: sessionId,
      expectedTitle,
      title,
    })) as { updated?: boolean } | undefined;
    if (written?.updated === true) {
      deps.logger.app("session", "info", "session title refreshed after compaction", {
        sessionId,
        data: { modelKey: request.modelKey },
      });
      deps.onTitleChanged?.(sessionId);
    }
    return written?.updated === true;
  } catch (error) {
    deps.logger.app("session", "warn", "session retitle after compaction failed", {
      sessionId,
      data: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** The one re-title instance the IPC/event layer wires in. */
export function createSessionRetitleGenerator(deps: SessionTitleDeps) {
  return (job: SessionRetitleJob) => generateSessionRetitle(deps, job);
}
