# ADR: Mobile client redesign — model capability, broken journeys, IA and visual system

- Status: Proposed — awaiting owner confirmation. No implementation is claimed.
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
- `catalog.ts` replaces the protocol-only rule with one classifier:

  | Output modalities | Chat protocol declared | Result |
  |---|---|---|
  | contains `text` | yes | chat-capable |
  | contains `image` and `openai-images` declared | — | image-capable |
  | only `image` | — | image-only (never offered for chat) |
  | undeclared | yes | chat-capable |
  | undeclared | `openai-images` declared | image "unconfirmed" — listed in a separate group of the image picker, selectable, labelled "gateway did not declare image output" |
  | anything else | — | listed as unavailable with the reason |

- A model can be both (e.g. `gemini-3.1-flash-image`): it appears in both
  pickers. The operation is chosen by where the user starts (chat vs studio),
  never by name.
- The rule "names prove nothing" stays. No fallback to another model or
  protocol on failure.

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
  storage format. Aspect ratio / count chips are shown only if D1 metadata and
  the request adapter support them; the first stage sends one image per
  request exactly as today (no invented parameters).
- H5 keeps the Computers root only, as today.

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

### D5. Journey fixes

B1–B6, B8, B11: fix in place; every guard that blocks an action shows the
reason (notice/toast). B6: actions on a replying conversation offer "stop and
archive/delete". B14: delete the dead components.

### D6. Settings without stubs

- Account card (account, balance when Router returns it).
- Default models (names, D2).
- Model gateway (connect / disconnect).
- Notifications: push permission state and a master switch backed by
  `usePushRegistration` returning its state (B10). Event-level toggles only
  if the gateway contract already supports them; otherwise not shown.
- Appearance: system / light / dark.
- Local history (count, clear), other accounts.
- About: app version, privacy policy link.
- "Computers" row removed (it is a tab).

### D7. Unchanged boundaries (explicitly not in scope)

- Deleting a remote session and session-wide approval grants stay
  desktop-only; the phone explains this instead of offering a dead button.
- No Router change, no new Router endpoint, no paid-provider testing.
- No new runtime dependency (haptics, animation libraries).

## 3. Delivery stages

Each stage is one commit, buildable and tested on its own.

1. Model capability (D1, D2): shared parser field + tests; catalog classifier
   + tests; connection migration + tests; draft-model navigation.
2. Journey fixes (D5) with regression tests per B-item.
3. Design tokens and UI primitives (D4).
4. IA: tab bar with Studio, Chats list/detail restyle, model picker.
5. Computers and remote session restyle (status chips: model + thinking,
   mode, permission from the session record).
6. Settings (D6) and i18n of hard-coded strings (B12) in all nine locales.
7. Spec sync: `docs/spec/04-ux/13-remote-mobile-client.md` sections for IA,
   Studio, Settings; E2E scenario docs for the new user paths.

## 4. Verification

- Unit: catalog classification table (D1) including the Router channel
  union case; connection migration (D2); one regression test per B-item.
- `pnpm --filter @minih-agent/remote-web typecheck` and `test`;
  `pnpm --filter @minih-agent/shared test`.
- UI: Playwright screenshots of the H5 dev build at 390×844 for each root
  and sheet, light and dark, with a stubbed catalog and history store.
- Not run without separate authorization: real Router requests, device
  builds (Xcode/Gradle), App Store/TestFlight.

## 5. Consequences

- The model lists become correct for every Router channel type, at the cost
  of depending on models.dev catalog references; models without one fall into
  the explicit "undeclared" groups rather than being guessed.
- Stored connections and direct-chat history remain readable by the old and
  new app; the only persisted addition is `lastImageModelId`.
- The visual rewrite touches most screens; stages 3–6 are behavior-preserving
  apart from the listed fixes, so regressions are caught by the existing 773
  tests plus the new ones.
