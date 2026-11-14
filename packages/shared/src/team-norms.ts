/**
 * Team norms: the rules every employee follows, written by the person
 * (employee mode 0.5 slice 6).
 *
 * Three sections — communication, scope, delivery — because that is how the
 * person thinks about a working agreement, and because one free-text blob gives
 * neither the page nor the prompt anything to point at.
 *
 * The stored form carries a version so a later shape can be migrated instead of
 * guessed at. An empty norm set is a real state: it means "the person has not
 * written any", and nothing is injected.
 */

export const TEAM_NORMS_VERSION = 1;
/** Characters one section may hold. */
export const MAX_TEAM_NORM_SECTION_CHARS = 1_000;
/** Characters all three sections may hold together. */
export const MAX_TEAM_NORMS_CHARS = 2_500;
/** How much of the norms the steward's own brief quotes. */
export const MAX_TEAM_NORMS_BRIEF_CHARS = 600;

export const TEAM_NORM_SECTIONS = ["communication", "scope", "delivery"] as const;
export type TeamNormSection = (typeof TEAM_NORM_SECTIONS)[number];

export type TeamNorms = {
  version: number;
  communication: string;
  scope: string;
  delivery: string;
};

export function emptyTeamNorms(): TeamNorms {
  return { version: TEAM_NORMS_VERSION, communication: "", scope: "", delivery: "" };
}

function section(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type TeamNormsCheck =
  | { ok: true; norms: TeamNorms }
  | { ok: false; reason: "section" | "total" };

/**
 * Read a stored or submitted value, bounded.
 *
 * Over-long input is **refused**, not truncated: a rule silently cut in the
 * middle is a rule the person believes they wrote and the employee never read.
 */
export function checkTeamNorms(value: unknown): TeamNormsCheck {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "section" };
  }
  const raw = value as Record<string, unknown>;
  const norms: TeamNorms = {
    version: TEAM_NORMS_VERSION,
    communication: section(raw.communication),
    scope: section(raw.scope),
    delivery: section(raw.delivery),
  };
  for (const key of TEAM_NORM_SECTIONS) {
    if (norms[key].length > MAX_TEAM_NORM_SECTION_CHARS) {
      return { ok: false, reason: "section" };
    }
  }
  const total = norms.communication.length + norms.scope.length + norms.delivery.length;
  if (total > MAX_TEAM_NORMS_CHARS) {
    return { ok: false, reason: "total" };
  }
  return { ok: true, norms };
}

/** Whether the person has written nothing, which is the initial state. */
export function teamNormsAreEmpty(norms: TeamNorms | null | undefined): boolean {
  if (!norms) return true;
  // A stored shape from another build may omit a section; a missing one is
  // empty, not a crash, because this rides along every task turn.
  return TEAM_NORM_SECTIONS.every((key) => !(norms[key] ?? "").trim());
}

/** One flat line of the written sections, for a prompt that must stay short. */
export function teamNormsSummary(norms: TeamNorms | null | undefined): string {
  if (!norms) return "";
  return TEAM_NORM_SECTIONS.map((key) => (norms[key] ?? "").trim())
    .filter(Boolean)
    .join(" ");
}