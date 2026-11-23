/**
 * What `SessionCreate({ title, model?, agent? })` resolves to before a row
 * exists (ADR session-create-model-and-role).
 *
 * Three decisions meet in this one place, and each of them is a refusal the
 * model can act on rather than a silent fallback:
 *
 * - **The role.** `agent` must name a definition this machine currently offers.
 *   The definition's prompt becomes a section of the session's system prompt, so
 *   an unknown or switched-off handle is refused instead of creating a session
 *   that quietly runs as nobody.
 * - **The model.** `model` may only name a model the user has opted into AI
 *   delegation, exactly the set `Task.model` obeys; a role's own pin is that
 *   role's default and needs no opt-in, the way repeating a definition pin is
 *   allowed on the Task path. Omitting both keeps today's behaviour: the
 *   session-creation model from Settings > AI.
 * - **The permission.** A created session inherits the dispatching session's
 *   ceiling, and a role that declares a narrower scope narrows it further. The
 *   host applies the stricter of the two (`session.create`), so this value can
 *   only ever narrow.
 *
 * It is a pure function over the host reads the caller already made, so the
 * priority chain is testable without Electron.
 */
import {
  imageGenerationBindings,
  isImageGenerationModel,
  modelWireIdsEqual,
  subagentModelKey,
  type AppSettings,
  type SubagentDefinition,
} from "@minih-agent/shared";
import { findSubagentProviderSource } from "@minih-agent/agent-runtime";

import { listReadyPluginModels } from "../plugin-agent-complete";

/** A concrete permission mode; `inherit` carries no scope of its own. */
export type DelegatedPermissionMode = "ask" | "accept-edits" | "auto";

/** The provider rows `providers.list` reports, in the shape the helper reads. */
export type SessionCreateProviders = Parameters<typeof listReadyPluginModels>[0];

/** The dispatching session's own facts, host-read and never model-supplied. */
export type SessionCreateSource = {
  projectPath?: string;
  thinkingLevel?: string;
  providerId?: string;
  modelId?: string;
};

/** The three arguments a `SessionCreate` call may add. */
export type SessionCreateArguments = {
  model?: string;
  agent?: string;
};

export type SessionCreateTarget = {
  providerId: string;
  modelId: string;
  /** The chosen model's key, for the tool's own report. */
  modelKey: string;
  /** Absent when nothing named a level, which keeps the source session's. */
  thinkingLevel?: string;
  /** The definition handle the new session acts in, when one was named. */
  agentName?: string;
  /** A role's own narrower scope; the host clamps it against the ceiling. */
  permissionMode?: DelegatedPermissionMode;
};

export type SessionCreateResolution =
  | { ok: true; target: SessionCreateTarget }
  | { ok: false; code: string; message: string };

export type SessionCreateResolutionInput = {
  args: SessionCreateArguments;
  definitions: readonly SubagentDefinition[];
  providers: SessionCreateProviders;
  settings: AppSettings;
  source: SessionCreateSource;
};

const MODEL_NOT_ENABLED_FOR_DELEGATION =
  "is not enabled for AI delegation. Turn on \"Available for AI delegation\" for it in model settings, or omit `model` to use the definition's default.";

function refusal(code: string, message: string): SessionCreateResolution {
  return { ok: false, code, message };
}

/**
 * The conversation models this machine can start a session on.
 *
 * The same list the settings row offers and the settings page cannot disagree
 * with: a ready provider's chat models, minus the image models the page excludes.
 * Both sides resolve that set with the shared image helper.
 */
function sessionModels(
  providers: SessionCreateProviders,
  settings: AppSettings,
): ReturnType<typeof listReadyPluginModels> {
  const imageModels = imageGenerationBindings(
    settings.imageGenerationModels,
    settings.imageGeneration,
  );
  return listReadyPluginModels(providers, settings).filter(
    (item) => !isImageGenerationModel(imageModels, item.providerId, item.modelId),
  );
}

type ReadyModel = ReturnType<typeof listReadyPluginModels>[number];

/**
 * Resolve a model key onto a ready model.
 *
 * Two spellings are accepted because two different catalogs write keys: the
 * settings row and `SessionCreate`'s own message use `<providerId>/<modelId>`,
 * while a definition pin and the delegation catalog use the vendor alias or the
 * provider's display name (`anthropic/claude-…`). An ambiguous alias resolves to
 * nothing rather than to a guess — the same rule `Task.model` follows.
 */
function resolveModelKey(
  key: string,
  models: readonly ReadyModel[],
  providers: SessionCreateProviders,
): ReadyModel | undefined {
  const exact = models.find((item) => item.key === key);
  if (exact) return exact;
  const slash = key.indexOf("/");
  if (slash < 1) return undefined;
  const providerPart = key.slice(0, slash);
  const modelId = key.slice(slash + 1);
  if (!modelId) return undefined;
  const provider = findSubagentProviderSource(providerPart, providers);
  if (!provider) return undefined;
  return models.find(
    (item) => item.providerId === provider.id && modelWireIdsEqual(item.modelId, modelId),
  );
}

/** Whether a resolved model is the one a definition pins. */
function isDefinitionPin(
  model: ReadyModel,
  definition: SubagentDefinition | undefined,
  providers: SessionCreateProviders,
): boolean {
  const pin = definition?.model;
  if (!pin) return false;
  const provider = findSubagentProviderSource(pin.providerId, providers);
  if (!provider || provider.id !== model.providerId) return false;
  return modelWireIdsEqual(pin.modelId, model.modelId);
}

/** Whether a resolved model is the exact model the dispatching session runs on. */
function isSourceSessionModel(model: ReadyModel, source: SessionCreateSource): boolean {
  if (!source.providerId || !source.modelId) return false;
  return (
    source.providerId === model.providerId && modelWireIdsEqual(source.modelId, model.modelId)
  );
}

/** The concrete scope a role declares, or nothing when it carries none. */
function rolePermission(definition: SubagentDefinition | undefined): DelegatedPermissionMode | undefined {
  const permission = definition?.permission;
  if (permission === "ask" || permission === "accept-edits" || permission === "auto") {
    return permission;
  }
  // `inherit` (and an absent scope) adds nothing: the session inherits the
  // dispatching session's ceiling.
  return undefined;
}

/**
 * Resolve `{ model?, agent? }` into the row `session.create` will write.
 *
 * Priority: `model` → the role's own pin → `settings.sessionCreateModel`, with
 * the role's `thinkingLevel` first and the role's narrower `permission` applied
 * on top of the inherited ceiling.
 */
export function resolveSessionCreateTarget(
  input: SessionCreateResolutionInput,
): SessionCreateResolution {
  const { args, definitions, providers, settings, source } = input;
  const models = sessionModels(providers, settings);

  const agentName = args.agent?.trim();
  let definition: SubagentDefinition | undefined;
  if (agentName) {
    definition = definitions.find((candidate) => candidate.name === agentName);
    if (!definition) {
      const valid = definitions.map((candidate) => candidate.name);
      return refusal(
        "INVALID_ARGUMENT",
        valid.length > 0
          ? `Unknown or disabled subagent "${agentName}". Available: ${valid.join(", ")}.`
          : `No subagent definition is enabled on this machine, so "${agentName}" cannot be a role.`,
      );
    }
  }

  const requestedModel = args.model?.trim();
  let chosen: ReadyModel | undefined;
  if (requestedModel) {
    chosen = resolveModelKey(requestedModel, models, providers);
    if (!chosen) {
      return refusal(
        "MODEL_UNAVAILABLE",
        `Model "${requestedModel}" is not a configured conversation model. Pick one from the delegation catalog in this tool's description.`,
      );
    }
    // Authorization is Main's own check (ADR subagent-model-opt-in): a model the
    // user did not opt into may not be spent on AI-driven work. Three keys are
    // not an override: the role's own default, the model this session already
    // runs on, and the session-creation model the user configured.
    const configuredCreationModel = settings.sessionCreateModel;
    const isConfiguredCreationModel =
      Boolean(configuredCreationModel?.providerId) &&
      configuredCreationModel!.providerId === chosen.providerId &&
      modelWireIdsEqual(configuredCreationModel!.modelId, chosen.modelId);
    if (
      !chosen.availableForSubagents &&
      !isDefinitionPin(chosen, definition, providers) &&
      !isSourceSessionModel(chosen, source) &&
      !isConfiguredCreationModel
    ) {
      return refusal(
        "PERMISSION_DENIED",
        `Model "${requestedModel}" ${MODEL_NOT_ENABLED_FOR_DELEGATION}`,
      );
    }
  } else if (definition?.model) {
    const pinKey = subagentModelKey(definition.model);
    chosen = resolveModelKey(pinKey, models, providers);
    if (!chosen) {
      return refusal(
        "MODEL_UNAVAILABLE",
        `The "${definition.name}" subagent pins "${pinKey}", which is not a configured conversation model. Pass \`model\` to choose another one.`,
      );
    }
  } else {
    const binding = settings.sessionCreateModel;
    if (!binding?.providerId || !binding.modelId) {
      return refusal(
        "MODEL_NOT_CONFIGURED",
        "No session creation model is configured. Choose one in Settings > AI (session creation model) before creating a session, or pass `model`.",
      );
    }
    chosen = models.find(
      (item) =>
        item.providerId === binding.providerId && modelWireIdsEqual(item.modelId, binding.modelId),
    );
    if (!chosen) {
      return refusal(
        "MODEL_UNAVAILABLE",
        `The configured session creation model "${binding.providerId}/${binding.modelId}" is not available. Pick another one in Settings > AI.`,
      );
    }
  }

  const thinkingLevel =
    definition?.thinkingLevel ?? settings.sessionCreateModel?.thinkingLevel ?? source.thinkingLevel;
  const permissionMode = rolePermission(definition);
  return {
    ok: true,
    target: {
      providerId: chosen.providerId,
      modelId: chosen.modelId,
      modelKey: chosen.key,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(definition ? { agentName: definition.name } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    },
  };
}