# Settings: seven fixed categories in a bottom sheet

- Status: Accepted for implementation
- Date: 2026-10-23
- Supersedes in part: ADR 0013 (four-destination compact directory) and the
  rail-specific navigation rows of the settings specs it points at

## Context

Settings had grown a fixed left rail with fourteen first-level destinations in
four titled groups. The rail cost ~275px of width on every screen, carried
duplicate surfaces (the cloud-sync form was both its own destination and
embedded in the accounts page), and mixed three different kinds of choice on
one axis: what the app looks like, what the agent may do, and which account or
machine it belongs to.

The rail was itself a frozen decision (D063/D070, then ADR 0013/0015/0026), so
changing it needs a record rather than an edit. Nothing about persistence,
ownership, or the plugin/security boundary changes here: the same destinations,
the same settings data, and the same single writers stay in place.

## Decision

1. **Seven fixed categories, at most two levels**: General / 常规, AI, Models /
   模型, Capabilities / 能力, Accounts / 账户, Projects / 项目, System / 系统.
   The second level holds the destinations that used to be rail rows:
   appearance, usage habits and shortcuts; chat experience, execution and
   permissions, instructions and memory, and voice; skills, MCP and subagents;
   accounts, devices, cloud sync and advanced; network, storage, and about &
   updates. Models and projects have a single page each, so they render no
   second level.
2. **The container is a bottom sheet, not a full-window takeover.** The panel is
   anchored to the window bottom at about 90% height with 16–24px side gutters
   and 18–20px top corners, rises in about 240ms, and leaves in about 180ms. The
   chat shell stays mounted and inert behind it. There is no drag-to-resize, no
   snap height, and no swipe-to-close.
3. **One configuration surface per capability.** Cloud sync is a page in the
   accounts category and nothing else embeds it; SSH hosts and the self-hosted
   gateway are that category's advanced page; plugin theme destinations hang off
   appearance instead of adding an eighth category.
4. **One navigation index, two-level search.** `lib/settings-search.ts` owns the
   category → destination → row map. Both the panel's search and the global
   search dialog read it, and a row hit carries its path
   (`System › Network › Proxy`). Destination ids are a contract: `remoteHosts`
   resolves to `advanced`, `remoteGateway` to `accounts`, and unknown ids fall
   back to appearance.
5. **Closing is explicit.** The close button and Escape close; Escape first
   yields to an open menu or dialog, and to a focused text field. The scrim is
   not a dismiss surface. Focus returns to the entry that opened Settings.

## Consequences

- The app keeps its full width while settings are open, and a conversation,
  draft, or running task stays visible behind the sheet.
- Duplicated surfaces disappear: one cloud-sync page, one advanced page for SSH
  and the self-hosted gateway, one appearance page that also hosts plugin theme
  entries.
- Existing deep links, automation calls, and plugins keep working through the
  legacy id map; the Host settings format is untouched.
- The rail, its four group headings, its footer action, and the
  `--ds-settings-nav-width` token are removed rather than kept behind a switch:
  no two shells coexist.
- Settings tests that asserted rail geometry, rail order, or the back-to-app
  action are rewritten as behaviour assertions about categories, the sheet, and
  closing; the focus, layering, and state-restoration protections they guarded
  stay covered.
- Component-level dialogs (model, skill, MCP, subagent editors) keep their
  centered modal form; only the settings container changed.

## Alternatives

### Keep the rail and regroup it

Rejected: the width cost and the duplicate surfaces were the problem, not the
grouping.

### Bottom half-screen sheet or a right drawer

Rejected: a half-screen sheet runs out of vertical space for long lists and
editors, and a right drawer is tight for model forms and instruction editing.

### Turn every settings destination into its own route

Rejected: it multiplies navigation chrome and makes "where am I" harder, without
removing the duplicate surfaces that motivated the change.

## References

- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `apps/desktop/test/settings-category-navigation.test.mjs`
- `scripts/e2e-settings-scroll.mjs`
