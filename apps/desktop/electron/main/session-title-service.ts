/**
 * Orchestrates one built-in title generation: ask the host whether the session
 * is still auto-title eligible, pick a model, run a one-shot completion, and
 * compare-and-set the title through the host.
 *
 * Kept separate from `agent-ipc.ts` so the flow is unit-testable with fake
 * ports. Fire-and-forget by contract: `generateSessionTitle` resolves to
 * `false` for every skipped or failed case and never throws, so the send path
 * can detach it without a rejection handler.
 */

import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import type { AppSettings } from "@minih-agent/shared";
import type { Context } from "@earendil-works/pi-ai";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "./oauth";
import type { Logger } from "./logger";
import {
  buildSessionTitleRequest,
  normalizeGeneratedTitle,
  type SessionTitleModel,
} from "./session-title-engine";

/** The slice of the launch resolver the title generator needs. */
export type SessionTitleLaunchResolver = (
  sessionId: string,
  session: unknown,
  settings: unknown,
  overrides?: {
    providerId?: string;
    modelId?: string;
    thinkingLevel?: string;
  },
) => Promise<{
  providerId: string;
  modelId: string;
  sidecarParams: {
    provider: RuntimeProviderConfig & { authKind?: string };
    thinkingLevel: string;
  };
}>;

export type SessionTitleDeps = {
  getHost: () => { call: (method: string, params?: unknown) => Promise<unknown> } | null;
  resolveAgentRuntimeLaunch: SessionTitleLaunchResolver;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
  logger: Pick<Logger, "app">;
  /** Guard against two generations racing on the same session. */
  inFlight?: Set<string>;
  /** Injectable completion for tests; production uses the runtime default. */
  completeOneShot?: typeof completeOneShotImpl;
};

/** One generation's trigger, read by the caller at send time. */
export type SessionTitleJob = {
  sessionId: string;
  /** The session's launch identity, used to resolve the title model. */
  session: {
    providerId?: string;
    modelId?: string;
  } | null | undefined;
  settings: AppSettings | null | undefined;
};

const inFlightSessions = new Set<string>();

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

/**
 * Generate a title for `sessionId` from its first persisted user message.
 *
 * Gate order matters: the settings gate runs first so a disabled feature
 * costs nothing, and `session.autoTitleContext` is the once-only gate — it
 * answers nothing once a manual or generated title owns the session, so no
 * later message ever renames it again and no wasted model call is made. The
 * naming input is always the first persisted user message, and the host CAS
 * stays the final arbiter: the write lands only while the expected title is
 * still current, so a manual rename always wins.
 */
export async function generateSessionTitle(
  deps: SessionTitleDeps,
  job: SessionTitleJob,
): Promise<boolean> {
  const sessionId = job.sessionId.trim();
  if (!sessionId || sessionId.startsWith("native-pi:")) return false;
  if (job.settings?.sessionTitle?.enabled === false) return false;

  const host = deps.getHost();
  if (!host) return false;
  const guard = deps.inFlight ?? inFlightSessions;
  if (guard.has(sessionId)) return false;

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
      userPrompt: context.userPrompt,
    });
    if (!request) return false;

    // Model override: resolve the launch with the overridden ids. Otherwise
    // the session's own launch is exactly what the turn itself uses.
    const launch = await deps.resolveAgentRuntimeLaunch(
      sessionId,
      job.session ?? {},
      job.settings ?? {},
      preferredModelKey && request.modelKey !== (context.modelKey ?? null)
        ? {
            providerId: request.modelKey.slice(0, request.modelKey.indexOf("/")),
            modelId: request.modelKey.slice(request.modelKey.indexOf("/") + 1),
            thinkingLevel: request.thinkingLevel,
          }
        : { thinkingLevel: request.thinkingLevel },
    );
    if (!launch?.sidecarParams?.provider) return false;
    const provider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;

    guard.add(sessionId);
    try {
      const result = await (deps.completeOneShot ?? completeOneShotImpl)(
        provider,
        {
          systemPrompt: request.system,
          messages: [
            { role: "user", content: request.userContent, timestamp: Date.now() },
          ],
        } as Context,
        request.thinkingLevel,
        { sessionId, maxOutputTokens: 128 },
      );
      const title = normalizeGeneratedTitle(result?.text);
      if (!title) return false;
      // The host refuses anything but the expected still-fallback title, so
      // a manual rename or a faster generated title always wins this write.
      const written = (await host.call("session.autoTitle", {
        id: sessionId,
        expectedTitle,
        title,
      })) as { updated?: boolean } | undefined;
      if (written?.updated === true) {
        deps.logger.app("session", "info", "session title generated", {
          sessionId,
          data: { modelKey: request.modelKey },
        });
      }
      return written?.updated === true;
    } finally {
      guard.delete(sessionId);
    }
  } catch (error) {
    deps.logger.app("session", "warn", "session title generation failed", {
      sessionId,
      data: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** The one generator instance the IPC layer wires in. */
export function createSessionTitleGenerator(deps: SessionTitleDeps) {
  return (job: SessionTitleJob) => generateSessionTitle(deps, job);
}
