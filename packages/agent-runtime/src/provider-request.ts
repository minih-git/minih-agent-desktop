/**
 * One place that turns a runtime's provider, context and options into the exact
 * request options pi-ai's adapters send.
 *
 * Two callers share it and must never diverge:
 *
 * - a real turn, from `DesktopAgentRuntime`'s `streamFn`;
 * - a keep-warm request (ADR 0339), which replays the same prefix outside any
 *   turn so an idle session keeps its provider prompt cache.
 *
 * A keep-warm request is only worth its cost while it is byte-identical to the
 * real request whose cache it refreshes: a single differing header, tool block
 * or thinking parameter would make the provider write a new prefix instead of
 * reading the old one, and the caller would pay a full cache write for nothing.
 * The assembly therefore lives here rather than being repeated, and it also
 * answers the prefix fingerprint both paths compare
 * (`keepWarmPrefixFingerprint`).
 */

import type {
  Api,
  FetchFunction,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { clampOutputToContext, requestTranscript } from "./output-cap.js";
import { omitThinkingModel } from "./thinking-level.js";
import {
  copilotRequestHeaders,
  providerRequestFetch,
  type ProviderEndpointFallbackState,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import { openCodeEndpointFromProvider, withOpenCodeSessionHeaders } from "./opencode-session-headers.js";
import { withSessionAffinityOptions } from "./session-affinity.js";
import { mergeProviderHeaders, withProviderHeaders } from "./provider-headers.js";
import {
  captureProviderResponse,
  type ProviderResponseSnapshot,
} from "./provider-retry.js";
import type { ProviderFetchFailure } from "./provider-transport-recovery.js";
import { keepWarmPrefixFingerprint } from "./keep-warm-fingerprint.js";

export type ProviderRequestCapture = (
  response?: ProviderResponseSnapshot,
  requestBytes?: number,
  failure?: ProviderFetchFailure,
) => void;

export type AssembleProviderRequestInput = {
  provider: RuntimeProviderConfig;
  /** The model row this session runs. */
  model: Model<Api>;
  /** The context pi handed the stream function for a turn, or the rebuilt one. */
  context: TranscriptContext;
  sessionId: string;
  /** Where the caller's own stream options start; `{...options}` in a turn. */
  base: SimpleStreamOptions;
  /** The caller's own `fetch`, wrapped by the capturing one; absent for a warm request. */
  baseFetch?: FetchFunction;
  /** Extension provider hooks, applied at the same point in both callers. */
  withHooks: (options: SimpleStreamOptions, model: Model<Api>) => SimpleStreamOptions;
  maxRetries: number;
  capture: ProviderRequestCapture;
  /** `options.onResponse` of the turn path; a keep-warm request has none. */
  onResponseSeen?: NonNullable<SimpleStreamOptions["onResponse"]>;
  endpointFallbackState?: ProviderEndpointFallbackState;
  /**
   * Reports a proven tunnel failure to Host Core (C2). Best-effort and never
   * awaited: the request that noticed the failure must not wait on the report.
   */
  onTunnelFailure?: (reason: string) => void;
  /** A turn runs on the low-level `stream` path when thinking is omitted. */
  omitThinking: boolean;
  /** An absolute output ceiling in tokens, applied before the context clamp. */
  maxOutputTokens?: number;
  /** An extra abort source: the turn's stall watchdog, or the warm request's own. */
  signal?: AbortSignal;
};

/**
 * The prefix digest of a context, computed the way a request would compute it.
 *
 * One definition for both callers: a turn digests the prefix it is about to send
 * (`assembleProviderRequest`), and the runtime digests the prefix it is about to
 * *be able to* send once a turn has settled. Two implementations would drift and
 * the guard would refuse forever.
 */
export function providerRequestPrefixFingerprint(input: {
  provider: RuntimeProviderConfig;
  model: Model<Api>;
  context: TranscriptContext;
}): { context: TranscriptContext; fingerprint: string } {
  const context = requestTranscript(input.model, input.context);
  return {
    context,
    fingerprint: keepWarmPrefixFingerprint({
      api: input.model.api,
      baseUrl: input.model.baseUrl,
      providerId: input.provider.id,
      modelId: input.provider.modelId,
      messages: context.messages,
    }),
  };
}

export type AssembledProviderRequest = {
  /** `omitThinkingModel(model)` on the omit path, the model itself otherwise. */
  model: Model<Api>;
  /** The transcript exactly as the adapter receives it. */
  context: TranscriptContext;
  options: SimpleStreamOptions;
  /** The output ceiling the request carries, after the context clamp. */
  maxTokens: number;
  /** Digest of everything that decides the provider's cached prefix. */
  fingerprint: string;
};

export function assembleProviderRequest(
  input: AssembleProviderRequestInput,
): AssembledProviderRequest {
  const model = input.omitThinking ? omitThinkingModel(input.model) : input.model;
  const prefix = providerRequestPrefixFingerprint({
    provider: input.provider,
    model: input.model,
    context: input.context,
  });
  const requestContext = prefix.context;
  const requestOptions: SimpleStreamOptions = withProviderHeaders(
    withOpenCodeSessionHeaders(
      {
        ...input.base,
        maxRetries: input.maxRetries,
        sessionId: input.sessionId,
        fetch: providerRequestFetch(
          input.model.api,
          captureProviderResponse(input.baseFetch, input.capture),
          input.provider.authKind,
          {
            primaryBaseUrl: input.model.baseUrl ?? input.provider.baseUrl,
            fallbackBaseUrl: input.provider.fallbackBaseUrl,
            state: input.endpointFallbackState,
            ...(input.onTunnelFailure ? { onTunnelFailure: input.onTunnelFailure } : {}),
          },
        ),
        ...(input.onResponseSeen
          ? {
              onResponse: async (response, responseModel) => {
                await input.onResponseSeen?.(response, responseModel);
              },
            }
          : {}),
      },
      {
        ...openCodeEndpointFromProvider(input.provider, input.model),
        sessionId: input.sessionId,
      },
    ),
    mergeProviderHeaders(
      copilotRequestHeaders(input.provider, input.context),
      input.provider.headers,
    ),
    input.model.api,
  );
  const hookedOptions = withSessionAffinityOptions(
    input.withHooks(requestOptions, input.model),
    {
      provider: input.provider,
      api: input.model.api,
      baseUrl: input.model.baseUrl,
      sessionId: input.sessionId,
    },
  );
  const requested =
    input.maxOutputTokens === undefined
      ? hookedOptions.maxTokens
      : Math.min(hookedOptions.maxTokens ?? input.maxOutputTokens, input.maxOutputTokens);
  const maxTokens = clampOutputToContext(input.model, requestContext, requested);
  const options: SimpleStreamOptions = {
    ...hookedOptions,
    maxTokens,
    ...(input.signal
      ? {
          signal: hookedOptions.signal
            ? AbortSignal.any([hookedOptions.signal, input.signal])
            : input.signal,
        }
      : {}),
  };
  return {
    model,
    context: requestContext,
    options,
    maxTokens,
    fingerprint: prefix.fingerprint,
  };
}