/**
 * Orchestrates one composer follow-up suggestion: read the settled
 * conversation from the host, pick a model, run a one-shot completion, and
 * hand the normalized text to the renderer's composer IPC.
 *
 * Modeled on the session title service: fire-and-forget by contract — every
 * skipped or failed case resolves to `null`, never throws, and the ask is
 * never on the send path's critical road. The renderer decides whether the
 * answer is still worth showing; this module only decides whether one can be
 * produced at all.
 */

import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import type { AppSettings } from "@minih-agent/shared";
import type { Context } from "@earendil-works/pi-ai";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "./oauth";
import type { Logger } from "./logger";
import {
  buildFollowUpSuggestionRequest,
  normalizeFollowUpSuggestion,
  type FollowUpSuggestionInputMessage,
} from "./follow-up-suggestion-engine";
import type { SessionTitleRequest } from "./session-title-engine";
import {
  sessionTitleModelsFromProviders,
  titleLaunchOverrides,
} from "./session-title-service";
import type {
  RuntimeModelResolver,
} from "./runtime/model-resolution";

export type FollowUpSuggestionDeps = {
  getHost: () => { call: (method: string, params?: unknown) => Promise<unknown> } | null;
  resolveRuntimeModel: RuntimeModelResolver;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
  logger: Pick<Logger, "app">;
  /** Guard against two generations racing on the same session. */
  inFlight?: Set<string>;
  /** Injectable completion for tests; production uses the runtime default. */
  completeOneShot?: typeof completeOneShotImpl;
};

/** One suggestion's trigger, read at renderer request time. */
export type FollowUpSuggestionJob = {
  sessionId: string;
  /** The session's launch identity, used to resolve the suggestion model. */
  session: {
    providerId?: string;
    modelId?: string;
  } | null | undefined;
  settings: AppSettings | null | undefined;
};

const inFlightSessions = new Set<string>();

async function resolveSuggestionProvider(
  deps: FollowUpSuggestionDeps,
  job: FollowUpSuggestionJob,
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

/**
 * Compose one suggestion for `sessionId` from its settled conversation.
 * Resolves `null` for every skip or failure; the last log line says why.
 */
async function composeFollowUpSuggestion(
  deps: FollowUpSuggestionDeps,
  job: FollowUpSuggestionJob,
  sessionId: string,
): Promise<string | null> {
  const host = deps.getHost();
  if (!host) return null;
  const settingsSuggestion = job.settings?.followUpSuggestion;
  const preferredModelKey = String(settingsSuggestion?.modelKey ?? "").trim();

  try {
    // The tail of the persisted conversation is the whole grounding input;
    // `contentLimit` keeps one huge message from ballooning the read.
    const read = (await host.call("session.get", {
      id: sessionId,
      messageLimit: 8,
      contentLimit: 4_096,
    })) as {
      session?: {
        messages?: FollowUpSuggestionInputMessage[];
        providerId?: unknown;
        modelId?: unknown;
      } | null;
    } | undefined;
    const stored = read?.session;
    const messages = stored?.messages;
    // The renderer sends only the session id, so the host read is also the
    // launch identity: with no configured key the session's own provider/model
    // proposes the suggestion, and only an explicit settings key replaces it.
    const storedIdentity =
      typeof stored?.providerId === "string" &&
      typeof stored?.modelId === "string" &&
      stored.providerId &&
      stored.modelId
        ? { providerId: stored.providerId, modelId: stored.modelId }
        : null;
    const sessionModelKey = storedIdentity
      ? `${storedIdentity.providerId}/${storedIdentity.modelId}`
      : null;

    // A listed model set doubles as the "is a provider ready" check: an
    // empty list means no usable provider, and no call is attempted.
    const listed = (await host.call("providers.list", {
      includeDisabled: false,
    })) as { providers?: Array<Record<string, unknown>> } | undefined;
    const request = buildFollowUpSuggestionRequest({
      preferredModelKey: preferredModelKey || undefined,
      sessionModelKey,
      thinkingLevel: settingsSuggestion?.thinkingLevel,
      models: sessionTitleModelsFromProviders(listed?.providers),
      messages,
    });
    if (!request) return null;

    const provider = await resolveSuggestionProvider(
      deps,
      { ...job, session: storedIdentity ?? job.session },
      request,
    );
    if (!provider) return null;
    const result = await (deps.completeOneShot ?? completeOneShotImpl)(
      provider,
      {
        systemPrompt: request.system,
        messages: [{ role: "user", content: request.userContent, timestamp: Date.now() }],
      } as Context,
      request.thinkingLevel,
      // One ghost line: 256 output tokens covers the 120-char cap in any
      // script, and the cap, not the token budget, bounds the display.
      { sessionId, maxOutputTokens: 256 },
    );
    const suggestion = normalizeFollowUpSuggestion(result?.text);
    if (!suggestion) return null;
    deps.logger.app("session", "info", "composer follow-up suggestion generated", {
      sessionId,
      data: { modelKey: request.modelKey },
    });
    return suggestion;
  } catch (error) {
    deps.logger.app("session", "warn", "composer follow-up suggestion failed", {
      sessionId,
      data: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Generate a follow-up suggestion for `sessionId`, or `null` when the feature
 * is off, the session cannot prompt (native read-only), the host is
 * unavailable, or another generation already owns the session.
 */
export async function generateFollowUpSuggestion(
  deps: FollowUpSuggestionDeps,
  job: FollowUpSuggestionJob,
): Promise<string | null> {
  const sessionId = job.sessionId.trim();
  if (!sessionId || sessionId.startsWith("native-pi:")) return null;
  if (job.settings?.followUpSuggestion?.enabled === false) return null;
  if (!deps.getHost()) return null;
  const guard = deps.inFlight ?? inFlightSessions;
  if (guard.has(sessionId)) return null;
  // Reserve synchronously, exactly like the title generator: two triggers that
  // both read the guard before either registered would run duplicate calls.
  const promise = composeFollowUpSuggestion(deps, job, sessionId);
  guard.add(sessionId);
  return promise.finally(() => guard.delete(sessionId));
}
