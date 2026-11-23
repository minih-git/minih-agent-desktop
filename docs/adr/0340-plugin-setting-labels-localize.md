# ADR 0340: Generated plugin settings localize their own labels

- **Status**: Accepted
- **Date**: 2026-11-23
- **Supersedes**: ADR 0280 decision 3, for `contributes.settings` only
- **Related**: [ADR 0280](0280-plugin-owned-ui-localizes-from-host-locale.md) ·
  [ADR 0267](0267-plugin-labels-follow-the-app-language.md) ·
  [ADR 0159](0159-plugin-generated-settings-and-local-shortcuts.md) ·
  [07-plugins/02-plugin-manifest-schema](../spec/07-plugins/02-plugin-manifest-schema.md)

## Context

ADR 0280 decided that generated `contributes.settings` rows stay author-language
plain strings: a plugin that needs a localized settings surface ships its own
`settingsDestinations`, and the host resolves locale maps only for identity and
chrome labels. The reasoning was sound at the time — a locale map on every
contribution field would grow a second, incomplete i18n system inside the
manifest, still limited to `en` and `zh-CN`.

In practice the generated sheet is the *cheap* settings surface, and it is the
one small plugins use. A Chinese user of a mail plugin sees "Mailbox provider"
and "Important senders" in English next to fully translated host chrome. The
alternative ADR 0280 offered — build a `settingsDestination` — asks an author to
ship a whole host-rendered settings page to translate two labels, which is a much
larger surface than the problem.

## Decision

1. `contributes.settings[].title`, `.description`, and `enum[].label` accept
   `string | { en, "zh-CN" }`, the same map the host already resolves for chrome
   labels.
2. Resolution happens in the host, against the app language, using the existing
   fallback order (`resolvePluginLocalizedString`): the active locale, then `en`,
   then whichever entry exists. The renderer still never parses a manifest.
3. A plain string is the author's own language and is shown exactly as written,
   so every manifest written before this rule renders identically and no
   migration exists.
4. Nothing else changes: commands, agent tools, themes, and the rest of
   `contributes` are not localization points, and this ADR does not open them.

## Consequences

- The generated sheet is a usable settings surface for a bilingual plugin, which
  removes the main reason to build a `settingsDestination` for two labels.
- The manifest now carries locale maps in two places — chrome labels and settings
  rows — with one resolver and one grammar. The "second i18n system" concern is
  smaller than ADR 0280 assumed because the resolver already existed; what grew
  is the set of fields that use it, not the mechanism.
- A plugin that wants more than two locales still ships its own surface; the
  manifest contract remains `en` + `zh-CN`.
- The renderer's `PluginSettingDefinition` keeps plain strings: resolution is a
  host concern, and `title` in that type is what the sheet draws.

## Alternatives

- **Require `settingsDestinations` for localized settings.** Rejected: it turns a
  wording fix into a new host-rendered surface, and the sheet already renders
  selects, models, and shortcuts that a destination would have to reimplement.
- **Resolve the map in the renderer.** Rejected again for the reason ADR 0267
  gave: the renderer would have to parse manifest data, which is exactly the
  boundary the IPC projection exists to keep.
- **Translate the sheet automatically from the host catalog.** Rejected: host
  catalogs know host copy, not a plugin's domain vocabulary ("Important
  senders"), and a machine translation in a settings form is worse than an
  untranslated label.