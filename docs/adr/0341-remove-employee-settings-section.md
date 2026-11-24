# ADR 0341: The employee settings section is removed

- **Status**: Accepted
- **Date**: 2026-11-24
- **Decision**: D692
- **Related**: [ADR bot-sessions-and-steward](bot-sessions-and-steward.md) ·
  [03-runtime/06-host-rpc-protocol](../spec/03-runtime/06-host-rpc-protocol.md) ·
  [03-runtime/04-data-storage](../spec/03-runtime/04-data-storage.md)

## Context

ADR `bot-sessions-and-steward` put the whole employee surface inside Settings:
destination `employees`, with three cards — team norms, hiring (six job templates
plus a one-sentence draft) and the employee list (create, edit, dismiss) — and,
below them, the lessons each employee had learned.

Two changes since then emptied that page:

- D689 removed the built-in Super Agent layer. The host no longer creates an
  employee for itself, so the page's seeding path, its steward row and the
  "enable the Super Agent" action went with it. What remained was a page whose
  first card pre-filled a form nobody was waiting for.
- The page kept its own vocabulary — 团队规范, 招聘, 员工列表 — that the person
  reads once and then never uses, because the daily surfaces of employee mode
  are the sidebar group, the workbench and the task cards, none of which live in
  Settings.

The user's decision (2026-11-24): delete the page, keep every stored record and
every plugin-facing surface, and design employee management again as part of the
Super Agent plugin (phase E), where an employee, its job and its rules can be
managed next to the thing that drives them.

## Decision

1. The settings destination `id: "employees"` (显示名「Super Agent」) is removed,
   together with its page and everything only that page used: the team-norms
   editor, the hiring area, the employee list and its two-step dismiss, the
   employee-lessons section, `BotFormCard`'s create-only model picker, the
   `useBotDefinitions` hook, the hiring templates in `packages/shared`
   (`bot-hiring.ts`) and the styles that only drew those surfaces.
2. The renderer-facing channels that existed only for the page are deleted with
   it: `bot.draftHire` with Main's one-sentence drafter, `team.norms.get` /
   `team.norms.set`, and `task.experience.list`. The renderer `api` loses the
   matching wrappers.
3. **A task turn no longer carries the team norms.** `buildTaskSessionBriefing`
   returns the task rules plus the relay-step rule and nothing else; the module
   that formatted the norms block is deleted. Nothing writes the norms any more
   either.
4. **Every stored record stays, and no schema changes.** `bot_profile_json`,
   `tasks.*`, employee lessons (`memory_*` with the `bot` scope), the
   `team`/`norms` row in `kv`, and the host RPCs that read and write them
   (`bot.create` / `bot.update` / `bot.dismiss` / `bot.forTaskSession`,
   `team.norms.*`, `task.experience.*`) are untouched. The Super Agent plugin
   decides what a turn does with the norms; until then they are inert data.
5. **Everything else in employee mode keeps working unchanged**: the sidebar
   group, the workbench, the task cards, the waiting channel, the relay, the
   plugin task interface `pi.tasks.roster/list/get/create/send/stop`, and the
   employee's profile tab, which still edits name, duty, permission ceiling,
   `mustAsk`, `observe`, project and definition through the same form.
6. A stored settings selection, a recent-settings entry or a deep link that names
   `employees` resolves to the default page (`general`) through
   `normalizeSettingsTabId`, never to an empty pane. The id is not redirected to
   another surface: the page it pointed at has no successor.

## Consequences

- The app has no UI to create or dismiss an employee, and none to write team
  norms or list/delete an employee's lessons. Creating an employee is a host RPC
  (`bot.create`) and a plugin call (`pi.tasks.create` with an existing
  `employeeId`) until phase E ships employee management; existing employees keep
  working in every daily surface.
- A task turn is shorter by the norms block, and the norms can no longer make a
  turn behave differently. That is a real behavior change for anyone who wrote
  norms; the alternative — keeping an editor for a prompt block with no reader —
  was rejected, because it would keep a settings page whose only card exists to
  write text nothing consumes.
- Lessons are still extracted from archived tasks and still injected into the
  next task of the same employee (ADR `bot-sessions-and-steward`, "Employee
  experience and inspection"). Only the person-facing list and delete are gone.
- Ten locales lose `bots.settings.*` keys that only the page read, plus
  `bots.norms.*`, `bots.hiring.*`, `bots.experience.*` and
  `settings.nav.employees`. A locale that translated the page now carries fewer
  keys, not stale ones.
- The removed IPC channels are gone from `IPC.invoke`, so a preload caller that
  still used them fails loudly instead of silently reaching nothing.

## Alternatives

- **Keep the page and hide the hiring card.** Rejected: the list would still be
  the only place an employee can be created or dismissed, so the page would keep
  its reason to exist and its IA cost, while the person has no reason to open it.
- **Keep the norms editor and their injection, drop only hiring.** Rejected for
  the reason in "Consequences": an editor whose text no turn reads is a settings
  page that lies about what it does.
- **Move the page into the sidebar or the workbench now.** Deferred, not
  rejected: that is the design question phase E answers with the plugin, and
  answering it before the plugin exists would put employee management in a third
  place.
- **Delete the host RPCs and the stored data too.** Rejected: the data is the
  user's, the RPCs are the plugin interface, and ADR `bot-sessions-and-steward`
  keeps employee identity, tasks and the permission ceiling host-owned.

## Enforcement status

| Rule | Enforced | Where |
| --- | --- | --- |
| No settings destination named `employees` | **Yes** — the id is gone from `SettingsTabId` and `SETTINGS_NAV` | `apps/desktop/src/lib/settings-search.ts`, `apps/desktop/test/settings-category-navigation.test.mjs` |
| A stale `employees` selection lands on the default page | **Yes** | `normalizeSettingsTabId`, same test |
| A task turn carries no team norms | **Yes** — no reader and no formatter left | `apps/desktop/electron/main/services/task-status.ts`, `apps/desktop/test/bot-task-briefing.test.mjs` |
| The page-only renderer channels are gone | **Yes** — absent from `IPC.invoke` and from `api` | `packages/shared/src/protocol.ts`, `apps/desktop/src/lib/api.ts` |
| Stored employees, tasks, lessons and norms are untouched | **Yes** — no schema change, no migration, no delete | `crates/host-core/` (unchanged) |
| The plugin task interface and the sidebar group keep working | **Yes** — untouched modules and their tests | `apps/desktop/electron/main/plugin-tasks-api.ts`, `apps/desktop/test/plugin-tasks-api.test.mjs`, `apps/desktop/test/bot-surfaces.test.mjs` |