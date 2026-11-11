import {
  ALWAYS_MUST_ASK,
  BOT_MUST_ASK,
  type BotListItem,
  type BotMustAsk,
  type BotProfileInput,
  type GlobalPermissionMode,
} from "@minih-agent/shared";

/**
 * The employee form's state and rules (ADR bot-sessions-and-steward §1).
 *
 * Kept as plain data plus two pure functions so the rules a person can observe
 * — `deploy`, `delete` and `spend` cannot be un-asked, `observe` starts on —
 * are testable without mounting the page.
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
  };
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
export function draftIsValid(draft: BotDraft): boolean {
  return draft.name.trim().length > 0;
}
