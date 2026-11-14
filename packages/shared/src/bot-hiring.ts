/**
 * Hiring: the templates a person picks from, and the words a role is called by
 * (employee mode 0.5 slice 6).
 *
 * A template is **pure data**. It names a job, not an employee: the person still
 * confirms a form, chooses the repository, and can change every field. What a
 * template cannot do is create anything by itself — nothing here is stored, and
 * nothing in this file calls a host or a model.
 *
 * Two shapes live here because three surfaces have to agree on them: the
 * settings page (which cards to show), Main (which definition a draft resolves
 * to, which model to suggest), and the steward's roster (what to call each
 * employee when choosing one).
 */

import type { BotMustAsk } from "./bot-session.js";
import type { GlobalPermissionMode, PermissionMode } from "./types/permissions.js";

export const HIRE_TEMPLATE_IDS = [
  "ui",
  "frontend-logic",
  "backend",
  "design",
  "review",
  "research",
] as const;

export type HireTemplateId = (typeof HIRE_TEMPLATE_IDS)[number];

/** How long the one-sentence hire box may be: a sentence, not a brief. */
export const MAX_HIRE_UTTERANCE_CHARS = 500;

/**
 * Which model a job prefers, as a hint for the form's default.
 *
 * - `ui`: interface work goes to a model that is good at visual reasoning (the
 *   Gemini family today);
 * - `coding`: the opposite preference — interface-first models are not the ones
 *   to hand a non-visual coding job;
 * - `none`: no preference, so the field stays empty and the person picks.
 */
export const HIRE_MODEL_PREFERENCES = ["ui", "coding", "none"] as const;
export type HireModelPreference = (typeof HIRE_MODEL_PREFERENCES)[number];

export type HireTemplate = {
  id: HireTemplateId;
  /** i18n keys, so the card and the draft prompt name the job the same way. */
  nameKey: string;
  dutyKey: string;
  /**
   * Definition handles to try in order; the first one installed wins. A list
   * rather than one name because a person's own `ui-coder` is better at
   * interface work than the shipped `ui-designer`, and it is theirs to install.
   */
  definitions: readonly string[];
  /**
   * The widest mode a hire from this template starts at. `inherit` is a
   * session-level word and is never a hiring default, so it is excluded here.
   */
  permissionMode: GlobalPermissionMode;
  /** Actions this job always brings back to the person. */
  mustAsk: readonly BotMustAsk[];
  /** Whether the job is about one repository. Research is not. */
  bindsRepository: boolean;
  /** Read-only work: the card may be started without the person. */
  readOnly: boolean;
  modelPreference: HireModelPreference;
};

/**
 * The six jobs (方案「岗位 × 仓库」).
 *
 * `ask` is the default for the two read-only jobs on purpose: a reviewer or a
 * researcher changes nothing, so the card can be started without a click, but
 * the moment it wants to act it has to ask.
 */
export const HIRE_TEMPLATES: readonly HireTemplate[] = [
  {
    id: "ui",
    nameKey: "bots.hiring.template.ui.name",
    dutyKey: "bots.hiring.template.ui.duty",
    definitions: ["ui-coder", "ui-designer"],
    permissionMode: "accept-edits",
    mustAsk: [],
    bindsRepository: true,
    readOnly: false,
    modelPreference: "ui",
  },
  {
    id: "frontend-logic",
    nameKey: "bots.hiring.template.frontendLogic.name",
    dutyKey: "bots.hiring.template.frontendLogic.duty",
    definitions: ["fixer"],
    permissionMode: "accept-edits",
    mustAsk: [],
    bindsRepository: true,
    readOnly: false,
    modelPreference: "coding",
  },
  {
    id: "backend",
    nameKey: "bots.hiring.template.backend.name",
    dutyKey: "bots.hiring.template.backend.duty",
    definitions: ["fixer"],
    permissionMode: "accept-edits",
    mustAsk: [],
    bindsRepository: true,
    readOnly: false,
    modelPreference: "none",
  },
  {
    id: "design",
    nameKey: "bots.hiring.template.design.name",
    dutyKey: "bots.hiring.template.design.duty",
    definitions: ["ui-designer"],
    permissionMode: "accept-edits",
    mustAsk: [],
    bindsRepository: true,
    readOnly: false,
    modelPreference: "none",
  },
  {
    id: "review",
    nameKey: "bots.hiring.template.review.name",
    dutyKey: "bots.hiring.template.review.duty",
    definitions: ["code-reviewer"],
    permissionMode: "ask",
    mustAsk: [],
    bindsRepository: true,
    readOnly: true,
    modelPreference: "none",
  },
  {
    id: "research",
    nameKey: "bots.hiring.template.research.name",
    dutyKey: "bots.hiring.template.research.duty",
    definitions: ["explorer"],
    permissionMode: "ask",
    mustAsk: [],
    bindsRepository: false,
    readOnly: true,
    modelPreference: "none",
  },
];

export function hireTemplate(id: unknown): HireTemplate | undefined {
  return typeof id === "string"
    ? HIRE_TEMPLATES.find((template) => template.id === id)
    : undefined;
}

export function isHireTemplateId(value: unknown): value is HireTemplateId {
  return hireTemplate(value) !== undefined;
}

/**
 * The definition a template resolves to, given what is actually installed.
 *
 * `undefined` means the person has to choose one by hand: a template whose only
 * definition is missing must not silently run an employee under nothing.
 */
export function resolveHireTemplateDefinition(
  template: HireTemplate,
  installed: readonly string[],
): string | undefined {
  const available = new Set(installed);
  return template.definitions.find((name) => available.has(name));
}

/** One model the person has configured, as the hire form offers it. */
export type HireModelChoice = {
  /** `providerId/modelId`, the key a session stores. */
  key: string;
  label: string;
  /** Whether this is a model the `ui` preference wants for interface work. */
  interfaceModel: boolean;
};

/**
 * The models a hire form may suggest: enabled providers that hold a credential,
 * with each model they list.
 *
 * A provider without a credential is not "available", and offering it would put
 * a dead model in the form. Nothing here reads a secret.
 */
export function hireModelChoices(
  providers: readonly {
    id: string;
    name?: string;
    enabled?: boolean;
    hasSecret?: boolean;
    hasOauth?: boolean;
    authKind?: string;
    models?: readonly { id: string; label?: string; name?: string; enabled?: boolean }[];
  }[],
): HireModelChoice[] {
  const choices: HireModelChoice[] = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    // `none` is a provider that authenticates by network position; every other
    // kind needs a key or a vendor login to be usable at all.
    const usable =
      provider.authKind === "none" ||
      provider.hasSecret === true ||
      provider.hasOauth === true;
    if (!usable) continue;
    for (const model of provider.models ?? []) {
      if (model.enabled === false) continue;
      const label = (model.label ?? model.name ?? model.id).trim() || model.id;
      const text = `${provider.name ?? provider.id} ${model.id} ${label}`;
      choices.push({
        key: `${provider.id}/${model.id}`,
        label,
        interfaceModel: /gemini/i.test(text),
      });
    }
  }
  return choices;
}
/**
 * The form default for one template, or `""` when nothing fits the preference.
 *
 * "Fits" is deliberately weak for `coding`: any configured model that is not an
 * interface-first one. `ui` fails closed — with no Gemini-family model there is
 * nothing better than the person's own choice, and guessing would be worse than
 * an empty field.
 */
export function pickHireModel(
  template: HireTemplate,
  choices: readonly HireModelChoice[],
): string {
  if (template.modelPreference === "ui") {
    return choices.find((choice) => choice.interfaceModel)?.key ?? "";
  }
  if (template.modelPreference === "coding") {
    return choices.find((choice) => !choice.interfaceModel)?.key ?? "";
  }
  return "";
}

/**
 * A short, readable word for a definition handle, for the steward's roster.
 *
 * The steward reads the roster as prompt text and has to tell "who reviews"
 * from "who researches". The handles are the definitions' own names, which are
 * close to that already; this table is where the two that are not — `fixer` and
 * `ui-coder` — get the word the person would use.
 */
const ROLE_WORDS: Record<string, string> = {
  steward: "orchestrator",
  "code-reviewer": "reviewer",
  explorer: "researcher",
  "test-runner": "test runner",
  fixer: "coder",
  "ui-coder": "interface coder",
  "ui-designer": "designer",
};

/** The word a roster row uses for a definition, or the handle itself. */
export function roleWordForDefinition(definition: string | null | undefined): string {
  const name = definition?.trim();
  if (!name) return "";
  return ROLE_WORDS[name] ?? name;
}

/** Roles that only read: the steward may start their cards without a click. */
export function isReadOnlyDefinition(definition: string | null | undefined): boolean {
  const name = definition?.trim();
  if (!name) return false;
  return name === "explorer" || name === "code-reviewer";
}