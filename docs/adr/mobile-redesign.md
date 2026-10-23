# ADR: Mobile client redesign — model capability, broken journeys, IA and visual system

- Status: Accepted — implemented on branch feat/mobile-redesign (commits fb4d13dca…600a1308e).
- Date: 2026-10-23
- Owner request: "Mobile is still wrong: many features do not work, text and
  image models do not line up, and the pages are ugly. Redesign features and
  pages, with visual effects."
- Source baseline: Desktop `origin/main` `d42831016`; Router
  `internal/control/project_model_collection.go`,
  `internal/channel/modules/openai_compatible.go` at the local checkout.
- Scope: `apps/remote-web` (native iOS/Android and H5), plus one additive field
  in `packages/shared` (`MinihRouterModel.outputModalities`).
- Amends: [Mobile direct gateway chat](mobile-direct-gateway-chat.md) §3 (model
  eligibility), [Mobile experience completeness](mobile-experience-completeness.md)
  D2 (defaults) and D7 (image entry point).
- Preserves: ADR 0331 trust model, Router account binding, desktop-owned
  remote-session authority (no remote delete, no session-wide grant from the
  phone), direct-chat IndexedDB history format.
- Visual reference: `apps/remote-web/design/prototype/redesign.html`.
- Implementation: §3 maps each stage to its commit. Where a decision below
  reads differently from the code, the decision text has been corrected in
  place and the difference is named; the same corrections are restated for
  users of the client in
  [remote mobile client UX §19](../spec/04-ux/13-remote-mobile-client.md).

## 1. Context and evidence

### 1.1 Root cause: text and image models are misclassified

The phone decides "image model" from `protocols.includes("openai-images")`
(`src/lib/direct-chat/catalog.ts`, `resolveDirectModel` / `isImageModel`).

Router does not declare protocols per model. `/api/models` fills
`ProjectModelDTO.protocols` with the union of the **channel type's**
`ClientProtocols` over every route group serving the model
(`project_model_collection.go` `mergeProjectModelProtocols`,
`projectModelGroupProtocols`). The OpenAI-compatible channel declares
`openai-images` for every model it carries (`openai_compatible.go` routes
`OperationImagesGenerate` / `OperationImagesEdit`), as do the OpenAI, NewAPI,
SiliconFlow, sub2api and similar modules.

Consequence: every text model served through such a channel (gpt-5,
deepseek, qwen, …) is classified as an image model. It disappears from the
chat list ("image model, use elsewhere"), appears in the image list, and a
"new chat" on it is either refused or sent to `/v1/images/generations`.
This is the "models do not line up" report.

The per-model evidence Router does carry is the catalog reference
(`upstream_models[].catalog_reference.model.modalities.{input,output}`, sourced
from models.dev). The shared parser already reads `input` into
`inputModalities` but drops `output`.

### 1.2 Verified broken journeys

Paths relative to `apps/remote-web/src`.

| # | Journey | Evidence | Effect |
|---|---|---|---|
| B1 | Model switch in a new (unsent) conversation | `screens/DirectChatScreen.tsx` ModelSheet `onSelect` returns when `!conversation` | Picking a model does nothing |
| B2 | New conversation model travels through the shared `lastModelId` | `App.tsx` `onNewConversation` → `service.rememberModel` | Starting an image job makes the next "new chat" fail over to the picker |
| B3 | Retry of a failed image turn | `DirectChatScreen.tsx` `retry` guards on `resolveDirectModel(...).usable`, always false for image models | Retry silently does nothing |
| B4 | Retry / regenerate / edit-resend guard failures | `DirectChatScreen.tsx` `retry`, `regenerateMessage`, `handleConfirmEditResend` | Silent `return`, no notice |
| B5 | Rename in the info sheet | `components/direct/DirectChatInfoSheet.tsx` `useState(transcript?.conversation.title)` initialised before load | Field empty, Save disabled |
| B6 | Archive / pin / delete while replying | `lib/direct-chat/history.ts` `setArchived` returns when not idle; list caller does not stop or explain | Action silently ignored |
| B7 | "Chats" tab also shows image conversations | `screens/ChatsScreen.tsx` filter applies only to the Images tab | Two tabs overlap |
| B8 | Revoked remote session has no recovery action | `App.tsx` never passes `onForget` to `SessionScreen` | Dead end |
| B9 | Settings rows "Computers / Notifications / Appearance / About" | `screens/SettingsScreen.tsx` rows without handlers, subtitle "later" | Stubs |
| B10 | Push state never surfaced | `hooks/usePushRegistration.ts` declares a state but returns nothing | No way to see or toggle push |
| B11 | Copy failure swallowed | `DirectChatScreen.tsx` `copyMessage` | No feedback |
| B12 | Hard-coded Chinese strings | `AccountScreen`, `PairScreen`, `HostsScreen`, `ConnectScreen`, `ChatTimeline`, `HostRow`, `HostSheets` | Other locales see Chinese |
| B13 | Default model rows show raw ids, picker has no capability hints | `SettingsScreen.tsx`, `components/ModelSheet.tsx` | Hard to choose |
| B14 | Dead legacy components | `components/{ApprovalCard,InputCard,Composer,Timeline}.tsx` unreferenced | Maintenance trap |

Typecheck and the 773 existing unit tests pass on the baseline; none of the
above is covered by a test.

## 2. Decisions

### D1. Capability comes from per-model output modalities

- `packages/shared` parser adds `outputModalities?: string[]` (union of
  `catalog_reference.model.modalities.output`). Additive, optional field; the
  desktop ignores it.
- `catalog.ts` replaces the protocol-only rule with one classifier
  (`modelCapability` in `apps/remote-web/src/lib/direct-chat/catalog.ts`):

  | Output modalities | Protocols declared | Result |
  |---|---|---|
  | contains `text` | a chat protocol | chat-capable |
  | contains `image` | — | image-capable: listed by the image picker, sent to `/v1/images/generations` |
  | contains `image`, no `text` | — | image-only (never offered for chat) |
  | undeclared | a chat protocol | chat-capable, and only that |
  | undeclared | `openai-images` declared, no chat protocol | image "unconfirmed" — listed in a separate group of the image picker, selectable, labelled "gateway did not declare image output" |
  | anything else | — | listed as unavailable with the reason |

- Two rows of the proposed table changed while the classifier was written, and
  the table above is the implemented rule:
  - A declared `image` output is enough for the image picker; the proposal also
    required `openai-images` to be declared. The catalog reference is the
    stronger evidence, and the endpoint is fixed when the request is built, so
    the second condition decided nothing.
  - An undeclared row that already declares a chat protocol resolves to
    chat-capable only, and is not also listed as a maybe-image model. The
    channel union declares `openai-images` for every model behind such a
    channel, so that group would have contained every text model — the bug this
    decision exists to remove.
- The reasons a listed model is unavailable are three, and the picker prints the
  matching one: `image-model` (declared image output, "use in Studio"),
  `not-chat` (only non-conversation protocols such as `openai-embeddings`,
  `rerank`, `ocr`), and `unsupported-protocol` (no protocol this client
  implements).
- A model can be both (e.g. `gemini-3.1-flash-image`): it appears in both
  pickers. The operation is chosen by where the user starts (chat vs studio),
  never by name; an existing image conversation keeps sending images because
  `resolveSendTarget` reads that flag from the conversation record.
- `model.category` is not consulted: the shared parser derives it partly from
  the model's name for the desktop catalog's grouping, so a name such as
  `qwen-vl` would otherwise disable a model the gateway really serves.
- The rule "names prove nothing" stays. No fallback to another model or
  protocol on failure: a missing or unusable model resolves to "unavailable",
  which the picker turns into a prompt, never to another model chosen on the
  user's behalf.

### D2. Chat and image selections are separate state

- Connection storage gains `lastImageModelId`; `lastModelId` keeps meaning
  "last chat model". On read, a `lastModelId` that classifies image-only is
  moved to `lastImageModelId` (one-time, in memory then persisted).
- A new conversation carries its model in the navigation target
  (`{ kind: "chat", conversationId, draftModelId }`) instead of mutating the
  shared last-model. The draft screen holds the model in local state until the
  first message creates the record (fixes B1, B2).
- Defaults (`defaultChatModelId`, `defaultImageModelId`) keep ADR
  completeness D2 semantics. Pickers show the model name, vendor and
  capability chips; the star on a row sets the default.

Implemented in `lib/direct-chat/connection.ts` (`migrateLastModel`) and the
screens. The migration runs once, on the read that moves the value, and only
when the cached catalog row is image-capable and cannot hold a conversation; an
existing `lastImageModelId` is never overwritten, and a row the cache does not
hold is left alone, because an absent catalog is not evidence. A store that
refuses the write keeps the answer correct for the session. A record written
before `defaultChatModelId` existed is seeded from the migrated chat model, so
the default shown for chat is the model the user last chose. Studio resolves
its model as the account image default, then `lastImageModelId`, then nothing —
never a chat model on the user's behalf — and writes `lastImageModelId` when a
generation starts or an image model is picked. The draft's model is
`chat.draftModelId` in the navigation target and lives in the screen's own
state until the first message creates the record; it is never written to the
remembered chat model. The picker row itself shows the model id under a vendor
heading with its capability chips, context window and declared price; Settings'
default rows show a cleaned model name and the vendor.

### D3. Information architecture

Native build: three root tabs plus settings from an avatar button on every
root.

| Tab | Content |
|---|---|
| 对话 Chats | Text conversations only, pinned row, swipe actions, archived link, new-chat button |
| 创作 Studio | Image generation: gallery of image conversations' outputs, generating cards, prompt composer, full-screen viewer |
| 电脑 Computers | Existing hosts ▸ projects ▸ sessions stack |

- Studio replaces the Chats "Images" segment (fixes B7). It reuses the
  existing image conversation records and `image-generation.ts`; no new
  storage format. **Implemented without any aspect-ratio, size, count or
  quality control:** the request adapter supports one image per request and
  the D1 metadata carries nothing a parameter could be built from, so nothing
  is drawn rather than drawn disabled.
- Studio's shape (`lib/direct-chat/studio.ts`, `screens/StudioScreen.tsx`):
  image attempts grouped by calendar day with Today/Yesterday headings,
  generating cards pinned above the rest of their day, superseded failed
  attempts hidden once a newer attempt for the same prompt exists, archived
  conversations excluded, a full-screen viewer, retry, stop, delete (which
  stops a live generation first), and a reuse-prompt action. Picking a chat
  model inside Studio's picker moves to Chats with that model in the new draft.
- The tab bar is drawn only in a native build and only on a root; every pushed
  page hides it, so the conversation, Studio composer and session view keep
  their full height.
- H5 keeps the Computers root only, as today: the browser build has no tab bar,
  no Chats root and no Studio root.

### D4. Visual system "Aurora Glass"

- Tokens replace the current grey palette in `styles.css` (dark-first, full
  light theme, user override in Settings ▸ Appearance stored locally).
- Glass nav and tab bars (backdrop blur, opacity follows scroll), aurora
  gradient accent used sparingly, 14–20 px radii.
- Motion, all CSS/`requestAnimationFrame`, no new dependency, disabled under
  `prefers-reduced-motion`: drifting aurora on empty/hero states, spring
  sheets with drag-to-dismiss, sliding tab indicator, streaming caret glow,
  send→stop morph, image placeholder shimmer and blur-to-sharp reveal, swipe
  row actions, status pulse, top toast.
- Shared primitives live in `components/ui/`; screens stop hand-rolling class
  strings for buttons, rows and sheets.

Implemented in `apps/remote-web/src/styles.css` (tokens, glass, keyframes, and
one `prefers-reduced-motion` block that disables every animation and
transition) plus `components/ui/`. `lib/theme.ts` owns the preference:
`minih.remote-web.theme.v1` in `localStorage`, `data-theme` on `<html>`, and
`color-scheme` so native form controls and scrollbars follow the resolved
theme; a blocked store degrades to `system` instead of failing the launch. The
navigation bar switches to its blurred surface once the sibling `<main>`
scrolls past 12 px. The tokens keep the `--rm-` prefix and the status token
names of the mobile UX spec (§5.1), whose values were re-tuned rather than
replaced wholesale, so the desktop and the phone still read as one family.

### D5. Journey fixes

B1–B6, B8, B11: fix in place; every guard that blocks an action shows the
reason (notice/toast). B6: actions on a replying conversation offer "stop and
archive/delete". B14: delete the dead components.

Implemented as: `lib/direct-chat/target.ts` decides the operation for the
composer, retry, regenerate and edit-resend in one place, so an image turn
retries on the image endpoint (B3) and a refusal always names its reason (B4);
`lib/direct-chat/rename.ts` derives the rename field from the transcript, so a
load that arrives late no longer leaves the field empty (B5);
`lib/clipboard.ts` returns the copy outcome and the screen reports a failure
(B11); `lib/session-exit.ts` plus the `onForget` handler `App.tsx` now passes
let a revoked session leave and forget its credential, with a failed forget
reported afterwards (B8); `ChatsScreen`'s archive row stops a live reply first
and is labelled "Stop and archive" while it would (B6), and
`history.setArchived` refuses a live reply with `busy` instead of returning
silently. The four dead components (B14) were deleted in the same commit.

### D6. Settings without stubs

Every row performs a real action against live state (`screens/SettingsScreen.tsx`,
with the pure projections in `lib/settings-view.ts`):

- Account card: the connected key's name, masked key, `access_key_id`, and the
  number of models in the cached catalog. **No balance row:** `GET
  /api/auth/session` answers key identity only, so the card has no balance to
  show and none is invented.
- Default models (names, D2): one row each for chat and image, showing the model
  name and its vendor and opening the same picker to change the default.
- Model gateway (connect / disconnect), with a confirmation before the key is
  deleted and a failure reported in place.
- Notifications: the push permission state and a master switch backed by
  `usePushRegistration` returning its snapshot (B10), one diagnostics row
  naming the gateway and the number of registered credentials, and one line
  saying the gateway has no per-event filter switches. `PUT
  /v1/push/registration` accepts a single optional `onlyActionable` filter and
  no per-event toggles; this release does not send the filter, so all four event
  kinds are delivered and Settings draws no switch for them.
- Appearance: system / light / dark, applied immediately and remembered
  locally.
- Local history (count, clear behind a confirmation that names the account; a
  clear is refused while a reply is still arriving) and other accounts
  (read-only).
- About: app version, the active gateway origin, and a privacy-policy link
  **only when the build was configured with `VITE_PRIVACY_POLICY_URL`**. The
  version is the `package.json` value injected at build time (`define
  __APP_VERSION__` in `vite.config.ts`), so it cannot drift from the manifest;
  a build that cannot read the manifest fails instead of shipping an empty
  version.
- "Computers" row removed (it is a tab).

### D7. Unchanged boundaries (explicitly not in scope)

- Deleting a remote session and session-wide approval grants stay
  desktop-only; the phone explains this instead of offering a dead button.
- No Router change, no new Router endpoint, no paid-provider testing.
- No new runtime dependency (haptics, animation libraries).

## 3. Delivery stages

Each stage is one commit, buildable and tested on its own.

| Stage | Scope | Commit |
|---|---|---|
| 1 | Model capability (D1, D2): shared parser field + tests; catalog classifier + tests; connection migration + tests; draft-model navigation | `fb4d13dca` |
| 2 | Journey fixes (D5) with regression tests per B-item | `25cd2f81b` |
| 3 | Design tokens and UI primitives (D4) | `ef6daf0c5` |
| 4 | IA: tab bar with Studio, Chats list/detail restyle, model picker | `9847072db` |
| 5 | Computers and remote session restyle (status chips: model + thinking, mode, permission from the session record) | `f28f74a3d` |
| 6 | Settings (D6) and i18n of hard-coded strings (B12) in all nine locales | `600a1308e` |
| 7 | Spec sync: `04-ux/13-remote-mobile-client.md` §19, E2E scenario docs, this status | this documentation change |

Stage 7 is documentation only: no source file, test, config or locale changed
with it.

## 4. Verification

- Unit, as delivered: the classification table including the Router channel
  union case and the "declared both" row (`catalog.test.ts`); the connection
  migration (`connection.test.ts`); the send-target rule that carries the image
  operation into retry (`target.test.ts`); and one regression test per fixed
  journey: `rename.test.ts`, `clipboard.test.ts`, `session-exit.test.ts`, the
  archive refusal in `history.test.ts`, `studio.test.ts`,
  `model-picker.test.ts`, `session-chips.test.ts`, `settings-view.test.ts`,
  `theme.test.ts`, and the nine-locale catalog test.
- Commands run on the branch tip: `pnpm --filter @minih-agent/remote-web test`
  (858 tests, 73 files), `pnpm --filter @minih-agent/remote-web typecheck`, and
  `pnpm --filter @minih-agent/shared test` (1568 tests, 126 files) — all green.
- UI: no browser suite was added by these stages. The visual reference is
  `apps/remote-web/design/prototype/redesign.html`, and
  `pnpm test:e2e:remote-web` (E2E-266) still drives the H5 client in real
  Chromium at 390×844 with screenshots in both appearances; it was **not**
  extended for the three roots, so the new screens rest on unit tests and the
  prototype rather than on an E2E automation of their own.
- Not run, and not claimed: real Router requests, device builds
  (Xcode/Gradle), App Store/TestFlight.

## 5. Consequences

- The model lists become correct for every Router channel type, at the cost
  of depending on models.dev catalog references; models without one fall into
  the explicit "undeclared" groups rather than being guessed. In practice an
  OpenAI-compatible gateway whose models carry no catalog reference now shows
  those models under the unconfirmed image heading instead of presenting them
  as promised image models.
- Stored connections and direct-chat history remain readable by the old and
  new app; the only persisted addition is `lastImageModelId`. A record written
  before the separation opens with its remembered chat model moved to the
  image slot only when the cached row really is image-only, and its chat
  default is seeded from the model the user last chose for chat.
- The visual rewrite touches most screens; stages 3–6 are behavior-preserving
  apart from the listed fixes, so regressions are caught by the existing 773
  tests that passed on the baseline plus the new ones. On the branch tip the
  suites are 858 tests in `apps/remote-web` (73 files) and 1568 in
  `packages/shared` (126 files), plus typecheck.
