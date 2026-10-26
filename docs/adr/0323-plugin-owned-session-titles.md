# ADR 0323: Make Session Title Generation a Standalone Plugin

- Status: Accepted (core title generation restored by the 2026-10-17 amendment;
  the standalone plugin is superseded)
- Date: 2026-10-08
- Supersedes: ADR 0186
- Amended: 2026-10-08 (D654 restores the deterministic first-prompt fallback)
- Amended: 2026-10-17 (built-in title generation moves back into Electron main,
  triggered by the first sent message; the plugin's `session.autoTitle`
  permission and its CAS host boundary are kept)

## Context

The core currently derives a prompt fallback in the renderer and runs a
main-owned one-shot completion after a turn. That couples title policy to the
agent lifecycle and gives users no prompt or model controls. Automatic title
generation is optional behavior and belongs in an independently installable
plugin.

The plugin still needs a safe way to name a normal Desktop session. Existing
plugin session reads are limited to sessions imported by that plugin, while the
general transcript API is intentionally too broad for this task.

Removing every automatic write, however, also removed the deterministic label a
new session got from its first prompt. That label costs no model call and makes
an untouched session readable offline, so it stays in the core; only the
model-composed title moves to the plugin.

## Decision

- Keep one deterministic core title path: sending the first prompt into a
  session whose stored title is still a recognized placeholder writes a
  whitespace-collapsed, 48-character fallback through the host's
  `session.deriveTitle`. The host applies it only while the title is still a
  placeholder with the `default` source, so a manual rename or an earlier
  automatic title always wins, and the write never changes `updated_at`.
- The derived text keeps the `default` source. It is not a user choice, so the
  session stays eligible for automatic replacement by an installed plugin.
- Remove the built-in title completion. No title is composed from a model inside
  the core, and no core flow waits on one.
- Provide `session.autoTitle`, a dedicated high-risk permission for a narrow
  first-turn context and a compare-and-set title update. Context contains only
  the first user message and first assistant reply, each bounded, and is
  available only while the title source is `default`.
- Store `title_source` in host-core schema v23. Manual renames set `manual`;
  plugin updates set `generated`; a placeholder or a first-prompt fallback
  remains `default`. The title update compares the exact expected title and
  source so manual changes win races and survive renderer restarts.
- Ship title generation as the standalone `minih-agent-desktop-session-title-plugin`
  repository. The plugin listens for completed turns and uses the existing
  `agent.complete` and `models.list` APIs. Its settings panel exposes an
  editable prompt template, model selection, and thinking level.

## Consequences

- Without the plugin, a new session shows its localized default title until the
  first prompt derives a label from it, and keeps that label afterwards.
  Installing and granting the plugin is required for model-composed titles.
- The plugin can customize title policy without adding a second title engine
  inside Electron or the renderer.
- The new permission allows the plugin to see bounded excerpts from any
  active default-titled Desktop session. It does not expose attachments, tools,
  later messages, or a general transcript-read method.
- Future v22→v23 upgrades retain every pre-existing title as `legacy`: old data
  cannot distinguish untouched placeholders from deliberate same-text renames.
  This protects both at the cost of leaving old placeholders unchanged.
- New default-titled sessions still receive the first-prompt fallback. Already
  upgraded v23+ rows retain their recorded sources and are not reclassified.

## Alternatives considered

- Remove the first-prompt fallback together with the completion: rejected after
  review because readability would then depend on installing an optional plugin,
  and an untouched session would show a placeholder forever.
- Keep the completion in the core: rejected because it would still automatically
  spend model tokens and mutate titles when the optional plugin is absent.
- Give the plugin `session.read` or `session.read.own`: rejected because those
  permissions either expose a general transcript projection or only imported
  sessions and do not match the required boundary.
- Run a second title flow in Electron main: rejected because title policy and
  user-configured prompts/models belong to the plugin after this change.

## Amendment 2026-10-17: built-in title generation restored

Users expected automatic titles without installing a plugin, and the plugin's
settings panel duplicated model selection that Settings already owns. The
core regains title generation with a narrower trigger than the pre-0186 flow:

- Electron main composes one title from the first persisted user message only
  (no assistant reply), right after `session.appendMessage` on the send path.
  The request is detached: the send never waits on it, and every failure is
  logged and forgotten.
- The completion writes through a main-process `session.autoTitle` host RPC
  that calls the existing `set_automatic_session_title` compare-and-set, so a
  manual rename still wins any race and the deterministic fallback stays when
  the model is unavailable or returns nothing usable.
- Settings gains `sessionTitle` (`enabled`, `modelKey`, `thinkingLevel`). An
  empty `modelKey` uses the session's own model; an unadvertised thinking
  level degrades to `off`.
- The standalone Session Titles plugin and its `session.autoTitle` permission
  are superseded; the permission and the CAS boundary it introduced remain in
  host-core and are reused by the built-in flow.
- 2026-10-17 refinement: the send path asks the host for the auto-title
  context (`session.autoTitleContext`, reusing `sessions::auto_title_context`)
  before spending a model call. An already-named session answers nothing, so
  it is never renamed again and never costs a generation, and every generation
  uses the first persisted user message as its input — the "first persisted
  user message only" trigger above holds for resends too.
- 2026-10-17 compaction refinement: a summarized compaction checkpoint may
  refresh the title afterwards (`session.retitleContext` +
  `session.retitleFromCompaction`). The compare-and-set replaces a `default`
  **or** `generated` title so the name can follow the conversation's current
  subject, while a `manual` rename still wins every race; the naming input is
  the compaction summary, matched to the live checkpoint by a fingerprint the
  `compaction_end` event carries.
- 2026-10-18 refinement: the naming input is the user's own words plus the
  bounded text behind a pasted reference, the title follows the request's
  language, and a landed write announces itself. A large paste reaches the
  first message as an `@path` chip, so naming from the message text alone
  produced titles about the upload; Electron main now reads at most three
  regular text files from that session's own `pasted/` directory (2,000 code
  points each, 3,000 in total) from the head of each file, so a multi-megabyte
  paste contributes its opening instead of being dropped. Every step from the
  data root through `scratch/<session>/pasted/` must stay inside the previous
  one, so neither a file link nor a redirected `pasted/` directory can read
  another session or an arbitrary path. A prompt that only references workspace
  files adds their bounded names (contents are never read), so it is nameable
  instead of skipped. The prompt names a language only when the script
  identifies it — Han, Cyrillic, Arabic, Hebrew, and Devanagari are named as
  scripts, so kanji-only Japanese is not renamed in Chinese — and a compaction
  refresh carries the current title so a summary in another language cannot
  translate the name. The attachment decides the language only when the request
  has no words of its own. The deterministic fallback drops `@path` chips and
  keeps the placeholder when a prompt has no words, and every landed write
  (first title or refresh) emits one `sessionsChanged` event with reason
  `session.title`, because the renderer owns its own session list and otherwise
  kept showing the fallback.
- 2026-10-18 reliability refinement: the send path and the settled-turn retry
  share one generator whose run registry is reserved before the first await, so
  two triggers cannot compose the same session at once, and the retry waits for
  a running composition instead of skipping it — that composition can still
  fail after the turn ended. Only a real attempt spends the two-attempt budget.
  The requested model always decides the provider: a caller without a session
  binding passes the request's own `providerId/modelId`, because omitting the
  override fell back to the default provider and sent the naming input to a
  service the request never named.
