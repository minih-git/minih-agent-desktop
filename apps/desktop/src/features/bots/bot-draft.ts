import {
  ALWAYS_MUST_ASK,
  BOT_MUST_ASK,
  hireTemplate,
  pickHireModel,
  resolveHireTemplateDefinition,
  type BotListItem,
  type BotMustAsk,
  type BotProfileInput,
  type GlobalPermissionMode,
  type HireModelChoice,
  type HireTemplate,
} from "@minih-agent/shared";

/**
 * The employee form's state and rules (ADR bot-sessions-and-steward §1).
 *
 * Kept as plain data plus pure functions so the rules a person can observe —
 * `deploy`, `delete` and `spend` cannot be un-asked, `observe` starts on, a
 * template only ever narrows — are testable without mounting the page.
 */
export type BotDraft = {
  name: string;
  duty: string;
  permissionMode: GlobalPermissionMode;
  mustAsk: BotMustAsk[];
  observe: boolean;
  definition: string;
  /**
   * The repository this employee works in. Empty means unbound, which is a real
   * choice: an employee can dispatch and report without reading code, but it
   * cannot answer a question about a repository it cannot open.
   */
  projectPath: string;
  /**
   * The model this employee's sessions run on, as `providerId/modelId`
   * (slice 6). Only a new employee sets it: the picker is a hiring decision, and
   * a template suggests one from what the person already has configured.
   */
  modelKey: string;
};

/**
 * A new employee records and does not act, and already asks before the three
 * actions the executing side would add anyway. Showing them pre-checked means
 * the form tells the truth about the copy inside it instead of looking laxer
 * than the host will behave.
 */
export const EMPTY_BOT_DRAFT: BotDraft = {
  name: "",
  duty: "",
  permissionMode: "ask",
  mustAsk: [...ALWAYS_MUST_ASK],
  observe: true,
  definition: "",
  projectPath: "",
  modelKey: "",
};

/** Options in a stable order, so the same profile always renders identically. */
const MUST_ASK_ORDER: readonly BotMustAsk[] = BOT_MUST_ASK;

export function draftFromBot(bot: BotListItem): BotDraft {
  const profile = bot.profile;
  return {
    name: profile.name,
    duty: profile.duty ?? "",
    // `inherit` is a session-only mode; an employee profile stores a real one.
    permissionMode:
      profile.permissionMode === "inherit" ? "ask" : profile.permissionMode,
    mustAsk: mustAskSelection(profile.mustAsk),
    observe: profile.observe,
    definition: profile.definition ?? "",
    projectPath: bot.projectPath ?? "",
    // Shown only: an edit never moves an employee's model.
    modelKey: bot.modelKey ?? "",
  };
}

/**
 * A draft pre-filled from a hiring template (employee mode 0.5 slice 6).
 *
 * Every field is the template's opinion, and the person may change all of them:
 * the name and duty are only a starting point, the definition is whichever of
 * the template's candidates is actually installed, and the model is the best
 * match among the models they already have — or empty when nothing matches,
 * because a guess would be worse than an empty field.
 */
export function draftFromTemplate(input: {
  template: HireTemplate;
  name: string;
  duty: string;
  /** Handles the person has installed; the first template match wins. */
  definitions: readonly { id: string }[];
  models: readonly HireModelChoice[];
  /** Overrides, for the fields a model draft may narrow. */
  permissionMode?: GlobalPermissionMode;
  mustAsk?: readonly BotMustAsk[];
  projectPath?: string;
}): BotDraft {
  const { template } = input;
  const installed = input.definitions.map((definition) => definition.id);
  return {
    name: input.name,
    duty: input.duty,
    permissionMode: input.permissionMode ?? template.permissionMode,
    mustAsk: mustAskSelection(input.mustAsk ?? template.mustAsk),
    observe: true,
    definition: resolveHireTemplateDefinition(template, installed) ?? "",
    projectPath: input.projectPath ?? "",
    modelKey: pickHireModel(template, input.models),
  };
}

/** A draft pre-filled from a template the person clicked, by id. */
export function draftForTemplate(
  templateId: string,
  input: {
    name: string;
    duty: string;
    definitions: readonly { id: string }[];
    models: readonly HireModelChoice[];
  },
): BotDraft | null {
  const template = hireTemplate(templateId);
  return template ? draftFromTemplate({ template, ...input }) : null;
}

/**
 * Keep the selection, drop anything unknown, and always include the three the
 * host adds regardless. A stored profile that predates one of them therefore
 * shows the truth, not the stored omission.
 */
export function mustAskSelection(values: readonly BotMustAsk[]): BotMustAsk[] {
  const selected = new Set<BotMustAsk>([...values, ...ALWAYS_MUST_ASK]);
  return MUST_ASK_ORDER.filter((value) => selected.has(value));
}

/**
 * A click on one option. The always-asked three cannot be removed: the rule is
 * structural on the executing side, so the control must not imply otherwise.
 */
export function toggleMustAsk(
  values: readonly BotMustAsk[],
  value: BotMustAsk,
): BotMustAsk[] {
  if (ALWAYS_MUST_ASK.includes(value)) return mustAskSelection(values);
  const next = values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
  return mustAskSelection(next);
}

export function isMustAskLocked(value: BotMustAsk): boolean {
  return ALWAYS_MUST_ASK.includes(value);
}

/** The create/update payload. An empty definition means "no definition". */
export function botProfileInput(draft: BotDraft): BotProfileInput {
  const duty = draft.duty.trim();
  return {
    name: draft.name.trim(),
    ...(duty ? { duty } : {}),
    permissionMode: draft.permissionMode,
    mustAsk: mustAskSelection(draft.mustAsk),
    observe: draft.observe,
    ...(draft.definition ? { definition: draft.definition } : {}),
  };
}

/** The project fields a create or update carries. */
export function botProjectPatch(draft: BotDraft): { projectPath: string | null } {
  const path = draft.projectPath.trim();
  // `null` is an explicit unbind, so clearing a project in the form persists as
  // "no project" instead of looking like an untouched field.
  return { projectPath: path ? path : null };
}

/**
 * The model a create carries, when the form picked one.
 *
 * Only a create: an employee's model is fixed at hire in this slice, and sending
 * it on an update would be a change the form never offered.
 */
export function botModelPatch(draft: BotDraft): { modelKey?: string } {
  const key = draft.modelKey.trim();
  return key ? { modelKey: key } : {};
}

export function draftIsValid(draft: BotDraft): boolean {
  return draft.name.trim().length > 0;
}