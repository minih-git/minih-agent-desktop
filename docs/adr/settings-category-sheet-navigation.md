# ADR: Seven-category settings as a full-window page

- Status: Accepted; bottom-sheet presentation superseded by the full-window page
- Original decision: 2026-10-23
- Amendment: 2026-10-24, explicit user request to remove the bottom sheet
- Supersedes in part: ADR 0013's rail navigation; preserves the seven-category
  information architecture introduced by this decision

## Context

The original redesign reduced fourteen first-level destinations to seven
category roots and eliminated the duplicate cloud-sync configuration surface.
It also introduced a bottom-anchored modal presentation. The user subsequently
rejected that presentation: entering Settings from below felt inappropriate
for a desktop configuration page. This correction changes the container, not
the category structure or the application's settings data.

## Decision

1. Settings is a normal full-window page. It switches directly into the
   available client area without an outer backdrop, floating corners, shadow,
   bottom translation, or delayed unmount. There is no alternative sheet mode.
2. Preserve General, AI, Models, Capabilities, Accounts, Projects and System,
   with at most two navigation levels and the existing overflow-aware selector.
   Do not restore the old left settings rail.
3. Keep the chat shell mounted but hidden and inert while Settings is visible.
   Returning immediately restores its draft, transcript position and layout;
   running tasks are not stopped.
4. Reserve native toolbar clearance. The real page header provides dragging
   without overlapping native controls or obscuring search and return actions.
5. Preserve explicit-save draft protection, search retention and anchor
   expansion, legacy destination resolution, one cloud-sync configuration
   surface, plugin theme ownership and all existing permission boundaries.
6. The whole page is not a modal dialog and does not trap focus. Actual editors
   and unsaved-change confirmation remain dialogs with their existing Escape
   and focus behavior. There is no outside-click dismissal for the page.

## Consequences

- Configuration behaves like a desktop page rather than a temporary mobile
  sheet, while retaining the navigation simplification.
- Remove sheet-only animation state, keyframes, geometry tokens and backdrop
  handlers rather than leaving a dormant implementation.
- Existing form and capability editors remain unchanged; no Host API, storage
  format, migration, credential policy or feature capability changes.
- Regression tests retain draft, nested-editor, search and state-restoration
  coverage but assert full-page geometry and immediate navigation instead of
  bottom-sheet animation and scrim behavior.

## Alternatives

Keeping the sheet but disabling its animation was rejected: the user rejected
the bottom-overlay presentation itself. Restoring the old sidebar was not
requested and would undo the accepted category consolidation. A right-side
drawer would introduce a new interaction without addressing the user's wish
to remove the popup presentation.

## References

- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `apps/desktop/test/settings-category-navigation.test.mjs`
- `scripts/e2e-settings-scroll.mjs`
