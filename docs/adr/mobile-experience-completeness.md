# ADR: Mobile daily-use completeness and image workflows

- Status: Ready for bounded implementation; no implementation or device acceptance is claimed.
- Date: 2026-10-23
- Owner request: Write a complete ADR from the mobile gap report and deliver it to the named mobile implementation session. This authorizes the implementation handoff, not deployment, paid provider tests, or general permission expansion.
- Source baseline: Desktop `b3ba685b7a14a1ef094f3a58defe69ba1e0ddd59`. The preceding report inspected `ea21e6b5`; the decision-bearing source and contracts were rechecked at this baseline.
- Scope: `apps/remote-web` native iOS/Android direct chat and the shared remote-session experience. H5 receives compatible shared presentation improvements, not direct model-account login.
- Amends: [Mobile direct gateway chat](mobile-direct-gateway-chat.md), specifically default selection, attachment deferral, image production, native sharing, and message actions.
- Preserves: [ADR 0331](0331-self-hosted-gateway-and-mobile-client.md), [Router account binding](remote-control-router-account-binding.md), [Desktop image generation](image-generation-capability.md), and desktop persistence/security ownership.
- Behavior reference: [Mobile UX §18](../spec/04-ux/13-remote-mobile-client.md#18-daily-use-completeness-and-image-workflows).
- Contract references: [RACP](../spec/03-runtime/19-remote-agent-control-protocol.md), [Image generation](../spec/03-runtime/21-image-generation.md), [Remote security](../spec/05-security/02-remote-control-security.md).

## 1. Context and evidence quality

The owner reports inability to view or create images, missing image generation,
unusable session deletion, repeated model selection, no genuinely quick new
conversation, and many small mobile interaction failures. These are broken
user journeys, not a request to duplicate every competing AI product.

Two distinct products already share the phone UI:

| Journey | Request authority | History authority | Credential | Depends on a computer |
|---|---|---|---|---|
| Direct chat / new direct image work | Minih-Router model data plane | Phone-scoped IndexedDB | Model AccessKey in native secure storage | No |
| Remote Agent session | The selected Host through RACP | Host-owned transcript and files | Device grant | Yes |

Consistent interaction must not pretend that these authorities are identical.
In particular, local deletion is not remote deletion; viewing a transcript is
not permission to read arbitrary Host files; stop is not a billing refund.

### 1.1 Verified source observations

Paths in this table are relative to `apps/remote-web/src` unless stated otherwise.
References identify code, not proof about an installed build.

| Observation | Evidence | Interpretation |
|---|---|---|
| New chat always opens the model sheet | `screens/ChatsScreen.tsx`, `newChat` click handler | A remembered model does not remove the repeated step |
| Last model and per-conversation model already exist | `lib/direct-chat/service.ts`, `rememberModel`; `screens/DirectChatScreen.tsx`, `wantedModelId` | Extend policy and presentation; do not replace history |
| Image models are deliberately rejected by direct text dispatch | `lib/direct-chat/catalog.ts`, `resolveDirectModel` | Do not remove that guard and send image models to a chat endpoint |
| Direct chat hides attachment controls | `screens/DirectChatScreen.tsx`, `hideAttachments` | A separate working image-input path is required |
| Direct messages persist text only | `lib/direct-chat/history-store.ts`, `DirectChatMessage` | Adding image UI alone cannot preserve images across restart |
| Remote timeline attachments retain names and kinds, not readable media | `lib/timeline-types.ts`, `TimelineAttachment`; `lib/timeline-items.ts`, `attachmentsOf`; `components/chat/ChatTimeline.tsx` | A preview requires a trusted media reference and bytes, not another label |
| Direct delete exists and waits for an idle conversation | `components/direct/DirectChatInfoSheet.tsx`; `lib/direct-chat/history.ts`, `remove` | Improve reachability/error handling and reproduce the reported failure before blaming storage |
| Remote deletion/archive are owner-only | `packages/shared/src/racp.ts`, `RACP_OPERATIONS`; `packages/racp/src/auth.ts`, `GATEWAY_PAIR_ROLES` | A normal phone cannot truthfully offer permanent remote deletion |
| Search, pin, archive, rename, draft fields, retry and per-conversation execution already exist | `screens/ChatsScreen.tsx`; `lib/direct-chat/history.ts`; `lib/direct-chat/runner.ts` | Preserve and validate these capabilities rather than rebuilding them |
| The shipped HTML policy permits self/data/blob images, not arbitrary image origins | `apps/remote-web/index.html`, `img-src` | Removing image restrictions is not the image feature |
| Desktop image downloads depend on Node/DNS/undici | `packages/agent-runtime/src/image-generation/download.ts` | This implementation cannot be imported wholesale into a WebView |
| Router model grouping is not reliable image-input capability metadata | `packages/shared/src/minih-router-control.ts`, category derivation | Model names and UI category must not authorize image input |

The previous report's 24 items are a coverage checklist, not 24 reproduced
defects. No phone installation, installed version, production Gateway route,
or paid image request was tested in this design session. Source comments and
older spec implementation-status prose can be stale.

Competitive inspiration is limited to complete user journeys: start, send,
read, revise, save and manage. The earlier research did not verify a complete
ChatGPT/Claude/Poe matrix; this ADR makes no claim that every competitor ships
every feature, and no market assumption is a protocol requirement.

## 2. Goals and explicit non-goals

Goals, in order:

1. A returning user can open a new conversation and type without choosing the
   same model again. The model about to be charged remains visible.
2. A person can discover and complete allowed conversation actions from both
   the list and the conversation, with honest scope and recoverable errors.
3. Images form a complete path: attach or generate, view, reopen, save/share,
   and later edit without losing the original.
4. Small mobile details are accepted as user paths: keyboard, Back, drafts,
   interrupted execution, storage errors and permission refusal.
5. Reuse the existing mobile application, local history and Host boundaries;
   keep changes incremental and backward compatible.

Not authorized here: cloud transcript storage/sync, a new backend conversation
service, arbitrary Host filesystem access, stronger phone roles, changing
Router billing/routing, another agent/tool framework, voice/video generation,
a template marketplace, all-model advanced parameter panels, or an app-wide
redesign. No production deploy, account mutation or paid API test is implied.

## 3. Decisions

### D1. Complete the two existing journeys; do not merge their authority

Keep Chats and Computers as the native roots. Add **Create image** as a
first-class action and an **Images** filter inside Chats, not a third root or
a second history database. Chat and image work share list/search/detail
primitives but have explicit operation kinds. An image-only model never becomes
the text chat model. Remote sessions retain their Host/project context.

Shared presentation receives narrowly typed media and action data. Direct
request orchestration stays in the app runtime; remote orchestration stays in
`useSessionScreen` and Host services. Do not build a generic backend registry or
add source-kind branches throughout every component. Split an existing module
only where its actual responsibility would otherwise expand.

### D2. Explicit account-scoped defaults and one-tap new chat

Persist `defaultChatModelId` and `defaultImageModelId` as credential-free
preferences scoped by canonical gateway origin plus `access_key_id`. Keep the
existing last explicit choice and per-conversation model; they are not synonyms
for a configured default. These preferences are local, not Router account
settings and not the remote Host's default.

Selection rules for a new direct text conversation:

1. If an explicit default exists and is usable, use it without a model dialog.
2. If an explicit default exists but is missing/forbidden/unsupported, preserve
   it, explain why, refresh the catalog on request, and ask for a replacement.
   Never silently fall through to another paid model.
3. If no default exists, reuse a usable last explicit text choice. A one-time
   upgrade may seed the new default from that same account's valid last choice.
4. With no usable prior choice, show the chooser once. Saving that first choice
   as the default is explicit in the chooser copy. Never choose the first
   catalog row as a hidden paid default.

Settings exposes both defaults. A conversation model chip changes that
conversation; it does not overwrite the default unless the user explicitly
selects **Use for new chats**. Switching accounts never imports another
account's choices. Returning to an already known account restores its own
preferences. A failed preference write is reported, not called saved.

The list's primary New action and the conversation's New action open a blank
composer immediately when the selected default is usable. Focus the input in
the initiating gesture where the platform permits it. Returning from an existing
conversation does not force-open the keyboard. New does not make a billable
request and does not create an empty visible history row. Repeated taps cannot
create multiple screens or duplicate identities; use the existing UUID helper.

A nonempty pre-first-message draft must survive navigation. Keep it as a
credential-free, account-scoped draft in the same local repository; promote it
atomically on first send. Preserve the earlier rule that abandoned empty chats
leave no history row. No temporary draft may leak into another account.

For a remote project, Quick new uses the Host's established defaults and opens
the created session; **New with options** retains project/model/mode/permission
selection. Never apply a direct model id or default to RACP. Display the
Host-returned effective model and mode rather than claiming a guessed choice.

### D3. Reachable conversation actions and truthful deletion

Direct conversation rows gain a visible More action. Long press/swipe may be
shortcuts but never the only entrance. Reuse the same action surface from the
conversation header: rename, pin/unpin, archive/restore, copy/export and delete.
Keep current account scoping and the read-only policy for older accounts.

Deletion is a stateful operation, not an optimistic disappearance:

- The confirmation names the conversation and says it removes its local
  messages, attempts, draft and owned media from this phone, not Router usage
  records or files already saved to Photos/Files.
- An idle delete is one repository transaction. The list updates and navigation
  changes only after the transaction commits. An error keeps the row and shows
  the failed operation and recovery action; busy state must always settle.
- If this conversation has active text or image work, offer **Stop, then
  delete**. Abort only this conversation, await local terminal settlement, then
  delete. Late callbacks cannot recreate it. If stop/delete fails, keep the
  record. Explain that stopping does not guarantee upstream billing stops.
- A reply in a different conversation must not disable deletion of this one.
- A second delete of an already removed local id is idempotent after the same
  scope checks. It must not delete a newly opened conversation.
- Archive does not destroy content; existing restore behavior remains. Bulk
  selection and a recycle bin are not prerequisites for this repair.

**Remote boundary:** `session/delete` and `session/archive` remain owner-only.
This ADR does not grant a phone `owner`, lower operation roles, invoke arbitrary
Host tools to delete data, or label local hiding as remote deletion. A phone
without permission shows the reason and directs the user to the owning
computer. Existing supported rename/configure actions remain available.

Permanent deletion of a Host-owned session from an ordinary phone is a
separate unresolved product/security decision, not completed by this fallback.
If requested later, it needs an explicit narrowly scoped Host grant and a
reviewed authorization contract; neither a generic controller upgrade nor an
app-side confirmation is sufficient. The implementation must report this
remaining gap explicitly while completing local deletion.

### D4. Persist media as data, not Markdown paths or expiring URLs

Add an additive media store to the versioned direct-history database. Store
bounded raster bytes/Blob plus stable id, owner scope/conversation/message or
attempt, MIME, byte length and display dimensions. Messages/attempts reference
media ids; they do not embed arbitrary file paths or huge base64 strings in
text. Existing text-only rows need no destructive rewrite.

Media belongs to the same conversation and is deleted with it. Read-only older
account history remains readable under its original scope. Object URLs exist
only for display and are revoked when the viewer/thumbnail no longer uses them;
object URLs are never persisted. Referencing one media item in an image edit
does not transfer ownership or permit deleting its original.

Save user input media and the pending attempt before a billable request. Save
validated output media and terminal attempt metadata before claiming a durable
success. Quota/write failure retains the draft or received in-memory result,
reports **Not saved**, and offers local Save/Share recovery while the process
still holds the bytes. It never resends the generation to repair persistence.
Reopening must not claim to recover bytes that were never saved.

For generated assets, initially retain the existing desktop ceiling of 16 MiB
per image and the existing 180-second generation deadline as shared policy
constants, not duplicated numeric rules. First delivery requests one image per
explicit action; batch count and unrelated provider knobs are deferred. Input
limits remain transport-specific: the remote inline RACP budget is unchanged,
not silently imposed on direct gateway images. Bound direct input bytes, total
serialized request, decoder dimensions and output bytes in a single policy,
chosen from verified transport limits before enabling the path. State enforced
limits in UI and tests; never advertise unverified upstream limits.

### D5. One safe image viewer, with working input and read paths

Images in a timeline render as bounded thumbnails with loading, unavailable
and failure states. Tap opens a viewer with close, fit, zoom/pan, image count
when relevant, Save and Share. Back closes the viewer before leaving the
conversation. Preserve the timeline scroll position. Controls are accessible
without gestures and touch targets meet the existing 44 px minimum.

Direct image input uses the real platform picker, preview/remove and an
optional explicit camera action. Accepted bytes must be sniffed/decoded, not
trusted because of a filename or MIME declaration. Use existing shared raster
validation where it is environment-neutral. Do not execute SVG/HTML as image
content; do not invent HEIC support without the native decoding path. A
conversion or resize must be visible to the user and leave the source untouched.

Image input is enabled only for a verified input-capable model/protocol. The
current UI category and name heuristics are not evidence. Extend the shared
catalog projection from already returned authoritative metadata where possible;
represent unknown separately from false. If Router lacks the required fact,
report that dependency instead of guessing or auto-switching models. Snapshot
image bytes and model identity at send time. Subsequent turns include the
appropriate persisted images when reconstructing context; do not show an image
in history and then silently omit it from the request.

Use Chat Completions and Responses input serialization appropriate to each
existing direct adapter. Oversized or unsupported input fails before sending
and preserves the draft; there is no text-only silent fallback. Generic PDF,
audio and large-file ingestion are not included by adding image input.

### D6. Remote image access is session media, never a filesystem browser

A remote screenshot or generated image must be readable after reopening,
including an output originally produced on the computer. Merely caching
images selected on this phone does not solve the remote result path.

Reuse an existing bounded session-media read if implementation-time inspection
finds one. At the inspected baseline, attachment projection exposes only names,
and the owner-grade workspace file surface must not be repurposed. Therefore
the selected extension is a narrowly scoped, additive **session-media read**:

- The Host enumerates opaque media references only for raster attachments or
  outputs already associated with that session's transcript. The client cannot
  submit an arbitrary path/URL or make the Host register one by sending text.
- The Host validates the current device grant, session visibility and media
  membership on every read. Possessing a media id is not authorization.
- An optional capability advertises support per connection. A normal viewer
  may read authorized transcript media, not general workspace files. Existing
  workspace/delete roles and their device-class restrictions remain unchanged.
- Descriptors are additive and bounded; image bytes are never embedded into
  every history page or SSE event. The read uses bounded, sequential chunks
  below `maxFrameBytes`, with validated offset/length, MIME, total size and
  integrity metadata. The existing maximum frame and request limits remain.
- Host containment checks cover real paths, symlinks, changed files and missing
  outputs. Only registered session media under already approved roots is
  readable. Do not parse arbitrary Markdown links into filesystem authority.
- The Gateway relays authenticated bounded reads; it gains no permanent
  transcript/media storage and no generic download proxy.
- Old Hosts show a named **Requires a newer computer version** state. Missing
  files show unavailable, not a fabricated preview; revoked access drops the
  viewer and disposes transient bytes. Remote media is not silently added to
  the phone's durable direct-history database.

Before code for this extension, update the RACP and remote-security specs and
shared schemas/route table together, defining the exact operation, request
shape, limits and capability discovery over RACP-HTTP. Cover desktop Host and
CLI producers, or advertise false on an implementation that cannot serve it.
This ADR selects the authority boundary; the protocol spec owns wire details.

### D7. First-class direct image generation, not a chat-endpoint workaround

Create image opens the image composer with the account's image default, prompt
and Generate. If no valid image default exists, choose once from models
explicitly declaring `openai-images`. Text defaults remain unchanged. The
Images filter projects image conversations from the existing history store.
An image screen/detail retains prompt, model, time, outcome and saved results.

Use the existing model gateway's OpenAI Images generation data plane. A small
mobile adapter belongs beside `lib/direct-chat` and the existing app-owned
runner, with cancellation and repository seams. Reuse Node-free parsing/types
and validation where practical; do not import Electron, host-core, Node DNS or
the whole desktop agent runtime. Do not introduce new agent tool definitions
or alter the remote `GenerateImages` tool just to create a mobile button.

Capability checks distinguish generation, editing and input modalities. An
`openai-images` declaration is not proof of every optional size, quality, edit
or mask parameter. Initial generation sends the minimal verified fields and
one image; offer optional parameters only when supported by a tested contract.
Do not add model-name-specific capability guesses or a speculative adapter
framework. Existing desktop generation remains unchanged.

State semantics: persist pending before network; show running without a fake
percentage; terminal states are complete, failed, stopped or interrupted,
using the existing attempt vocabulary with an additive operation kind. A
provider response is not complete until required media persistence succeeds.
Store any verified usage returned by the provider, but do not invent price or
credit balances. A retry is an explicit new billable attempt, never an
automatic fallback to another endpoint/model.

Use the existing abort/timeout lifecycle. An image operation in A does not
block text chat in B. Repeated Generate taps cannot duplicate an active attempt
in A. Navigation does not cancel work. Account unlink/change aborts the old
account's work; stale callbacks are rejected by account/conversation/attempt
identity. Backgrounding flushes state but does not promise OS background
execution; resume never automatically submits another paid request.

### D8. Safe output acquisition, save/share and editing

Prefer validated inline output bytes from the image endpoint. If the gateway
returns an image URL, accept only a validated HTTPS asset target and acquire
bounded bytes before treating the image as durable. Never pass the model
AccessKey, device token or cookies to a third-party asset host. Do not log
signed URLs or put them in exports.

The minimum implementation supports inline bytes and same-configured-origin
asset reads through the established authenticated request service. External
asset URLs need an already enforced public-address/redirect policy in a native
downloader or gateway asset facility. A hostname regex, CORS relaxation or
`img-src *` is not that policy. If no such facility exists, preserve a specific
**Result received but asset download unsupported** failure and report the
provider compatibility limitation; do not retry generation automatically.
Supporting an affected route is a completion dependency, not an excuse to call
URL-only output fully supported. Arbitrary remote Markdown images are not
authorized to bypass this boundary.

Save and Share are user gestures over local validated bytes. Prefer existing
Capacitor/native facilities; add a narrow maintained platform plugin only if
there is no current implementation. Share uses the system sheet, grants access
only to the selected temporary file, treats user cancellation as cancellation
and cleans temporary files. Save uses Photos/Files as appropriate, requests
only the required permission, and distinguishes denied, failed and saved. A
permission denial offers recovery/settings where the OS supports it. Never
claim that opening a URL is equivalent to saving a file.

The next bounded increment adds **Edit this image** only for a verified edit
contract: retain original bytes, submit the selected image plus new prompt,
store a new attempt/output with a source-media reference, and allow returning
to the original. Masks, multi-image composition and arbitrary batch studios
are deferred. Missing edit support has an explicit reason, not a generation
request that discards the supplied image.

### D9. Message actions without destroying existing history

Provide per-message Copy in addition to existing whole-conversation and code
copy. Copy failure is visible. Accessible More is the primary entrance; a long
press may open the same menu. Remote copy is presentation-only and does not
mutate Host history.

For direct conversations, implement these bounded subsequent actions:

- **Regenerate** the latest complete assistant reply creates a new attempt
  against the same user message. Retain the previous answer, identify the
  selected successful attempt, and use exactly one selected answer in later
  context. Failure/interruption does not erase the previous successful answer.
  Display the model and explain a changed model before submission.
- **Edit and resend** creates a new local conversation from the completed
  prefix before the edited user message plus the edited message. Preserve the
  original conversation and later turns. Reuse/copy media with explicit
  ownership so deleting either conversation cannot corrupt the other. An
  arbitrary in-place branch editor is not required.
- Both actions are explicit paid sends, gated on scope/model/capability and
  source conversation state. Unsupported remote edits/regeneration are not
  simulated by altering displayed messages.

### D10. Honest durability, bounded export and deferred sync

Keep search, pin/archive/restore, saved drafts and history available offline.
Add a user-triggered per-conversation text/Markdown export through the existing
copy path or native sharing, with model and completion markers. Clearly state
that this is a readable export, not a restorable full backup; media must either
be included as actual files by an implemented format or explicitly excluded.

Full backup/import and cross-device conversation sync are deferred decisions.
They require a versioned archive/import policy or a transcript authority with
conflict/deletion/encryption rules. Do not use Router request logs, configuration
backup, or the remote Gateway as a transcript store. Settings states that
uninstall/clear-data can lose local history and that direct phone chats are
not automatically desktop chats. No new cloud service is required for this ADR.

### D11. Mobile details are acceptance criteria, not polish afterwards

Preserve the shared keyboard/visual viewport shell, screen stack, theme/i18n
and scroll-follow behavior. Validate the changed paths at 320×568 and 390×844,
landscape, light/dark, zh-CN/en and long labels, plus 200% text scaling.

Keyboard leaves send/stop accessible; viewer and sheets close before Back
leaves the page; returning to a list does not jump to an unrelated position;
loading an image does not yank a reader who scrolled upward. Permission errors,
quota errors and failed saves retain actionable controls. Streaming changes
are announced by status rather than each token. No functionality depends only
on color, hover, swipe or a tiny unlabeled icon.

Preserve concurrent conversations and account isolation. Check app switch,
short background, network loss and process restart separately. The app shows
what was persisted and whether an attempt was interrupted, never false
completion or automatic re-billing. A real-device failure remains unverified
until reproduced on that platform/version; desktop Chromium is not an iOS
background, photo permission or native share acceptance substitute.

## 4. Ownership, compatibility and migration

| Area | Owner and permitted change |
|---|---|
| Mobile UI and workflows | `apps/remote-web`: screens, focused hooks/services, local direct repository, native adapters and locales |
| Shared data contracts | `packages/shared`: additive media/capability definitions and environment-neutral validation; no desktop imports |
| Remote media authorization/read | `packages/racp`, Host ports and the existing desktop/CLI Host owners; Gateway route forwarding only as needed |
| Desktop SQLite and existing image generation | Existing Host/core/runtime owners; no move into renderer and no unrelated rewrite |
| Model catalog/routing/billing | Minih-Router; consume its existing contracts; coordinate a separate bounded Router task only when a verified missing contract blocks delivery |

Bump the local history schema once for a coherent additive store/field change,
with old text rows interpreted as text and absent media arrays as empty. Cover
an existing database, empty database, blocked upgrade, quota failure and a
newer-schema downgrade. Never clear a database to recover. Preserve titles,
order, pins, archives, attempts, scope and drafts. Export remains possible
where the currently supported schema allows reading.

Local delete includes newly owned media in the same transaction. External
exports and platform share temporary files have their own lifecycle and are
not recursively deleted with a chat. No unbounded background media sweeper or
new storage abstraction is justified before a concrete need.

RACP descriptors/capabilities are optional and additive. Old clients ignore
new fields; new clients show truthful unsupported states against old Hosts.
Every new remote read must be tested across unauthorized sessions and account
changes. Do not advertise support until the relevant Host and HTTP discovery
path can actually serve it.

## 5. Alternatives and trade-offs

| Alternative | Why not selected |
|---|---|
| Always choose the first model | Hides a paid model decision and changes behavior when the catalog order changes |
| Always show the picker | Repeats work even though the user already chose; this is the reported friction |
| Make image models usable as chat models | Calls the wrong protocol; it does not implement generation |
| Add only image thumbnails | Breaks reopen, generated output and deletion cleanup; no durable ownership |
| Open arbitrary paths/URLs or widen CSP | Bypasses authority and can leak credentials; not a media delivery mechanism |
| Give phones owner so delete works | Also changes filesystem/tool powers; disproportionate and unauthorized |
| Merge direct and remote history | Makes offline access, deletion and credentials ambiguous |
| Add a separate image app/store | Duplicates history, account scope, deletion and lifecycle logic |
| Automatically retry image calls after a timeout | Can charge twice when the first request completed upstream |
| Introduce cloud sync now | Adds a server authority and conflict/security decisions unrelated to basic usability |

Benefits: fewer repeated steps, discoverable actions, durable media, reuse of
existing workflows, and honest limitations. Costs: a local schema migration,
a mobile image transport/native sharing boundary, and a narrow remote media
contract. Risks concentrate in account scoping, storage quota, asset fetching,
deletion races and OS lifecycle; the acceptance paths below target those risks.

## 6. Delivery scope and traceability to the 24-item report

These phases are dependency order, not calendar estimates. A phase is complete
only when its enabled user path works; a lower layer alone is not delivery.

| Phase | Bounded outcome | Dependencies |
|---|---|---|
| A — Daily chat | Defaults, one-tap new, draft preservation, list actions, reliable direct deletion, explicit remote permission boundary | Existing local repository/model catalog |
| B — Media foundation | Additive storage migration, viewer, safe direct image input, remote session-media read, save/share | Authoritative image-input metadata and bounded remote protocol |
| C — Image creation | Image entry/filter/default, one-image generation, durable result, failure/stop/retry; reuse B viewer/export | Verified Images data plane and safe asset acquisition |
| D — Bounded completion | Image editing when supported, per-message copy, regenerate, non-destructive edit/resend, readable export | B/C storage and attempt semantics |
| Across phases | Keyboard/Back, small screens, concurrency, background/interruption, permissions and old-data checks | Each changed journey |

| Report item | Disposition | Decision / acceptance |
|---|---|---|
| 01 Quick new chat | A | D2 / AC01 |
| 02 Default model | A | D2 / AC01–02 |
| 03 Default becomes unavailable | A | D2 / AC02 |
| 04 List-level conversation actions | A | D3 / AC03 |
| 05 Direct deletion | A; reproduce the reported installed-build symptom | D3 / AC03–04 |
| 06 Remote deletion/lifecycle | A provides truthful permission UI; permanent phone deletion remains blocked on separate authorization design | D3 / AC05 |
| 07 Historical image thumbnails | B | D4–6 / AC06–08 |
| 08 Full image viewer | B | D5 / AC08, AC15 |
| 09 Direct image input | B | D5 / AC07 |
| 10 Image module and model classification | C | D1, D7 / AC09 |
| 11 Generation and task state | C | D7 / AC09–10 |
| 12 Minimal generation parameters | C: one image, verified fields only; advanced options deferred | D7 / AC09 |
| 13 Durable results | B/C | D4 / AC06, AC10 |
| 14 Save and system share | B/C | D8 / AC11 |
| 15 Continue editing an image | D with verified edit contract | D8 / AC12 |
| 16 Message copy/menu | D; retain existing copy meanwhile | D9 / AC13 |
| 17 Edit sent message | D: new conversation, no destructive rewrite | D9 / AC13 |
| 18 Regenerate a successful answer | D: new attempt, retain previous | D9 / AC13 |
| 19 Export/backup/restore | D readable export; full backup/import deferred, not claimed complete | D10 / AC14 |
| 20 Cross-device continuity | Clear local/remote scope now; sync/desktop continuation deferred | D1, D10 / AC14 |
| 21 Keyboard and Back | Across phases; not a pre-proven defect | D11 / AC15 |
| 22 Interruptions and recovery | Across phases; preserve existing behavior | D7, D11 / AC10, AC16 |
| 23 Photo/file permissions | B/C; image scope only | D5, D8 / AC11 |
| 24 Layout and accessibility | Across phases | D11 / AC15 |

## 7. Acceptance and developer validation

### 7.1 Observable acceptance cases

| ID | User path and expected result | Lowest useful verification |
|---|---|---|
| AC01 | Choose a text default once; restart; New opens the composer without a picker; New from a chat preserves its draft and starts no request | Preference/history unit + mounted UI flow |
| AC02 | Default removed, forbidden, image-only or catalog read failed; no silent substitution; account A/B defaults and existing session choices stay independent | Catalog/policy and scope tests |
| AC03 | From list and header: rename, pin, archive, restore and idle delete survive reload; a failed delete leaves a visible row and actionable error | Repository + UI action flow |
| AC04 | Stop-then-delete during text/image work; late response, repeated click, concurrent other chat and storage failure cannot recreate or delete the wrong conversation | Controlled runner/storage race test |
| AC05 | Phone cannot delete/archive a Host session; explanation names the owner boundary; no owner grant or forbidden fallback request is sent | Role/contract regression + UI flow |
| AC06 | Upgrade populated old history; save raster media; restart/offline view; delete owner; quota/blocked upgrade never clears existing text/history | Migration/repository and browser IndexedDB test |
| AC07 | Pick image, preview/remove, send and follow up using both supported text adapters; unsupported/unknown modality or oversize preserves draft and sends nothing | Request contract + picker/composer flow |
| AC08 | Remote input and generated output reopen from trusted media refs; wrong session/device, traversal, symlink, changed/deleted file and old Host fail safely; viewer works on authorized bytes | Host/HTTP contract + remote UI flow |
| AC09 | Create image selects its own default, requests the Images endpoint once, saves a result visible under Images and the conversation; chat default unchanged | Stub data-plane contract + UI flow |
| AC10 | Timeout, quota, 401, cancellation, storage failure and interrupted download are distinct; user chooses retry; successful bytes are not regenerated to retry saving | Runner/transport tests with controlled timing |
| AC11 | Save/share works on local bytes; denied permission, user cancel, disk error and external URL refusal are visible without credential leakage | Native boundary tests + authorized device acceptance |
| AC12 | Edit supported result with a new prompt; original remains; new output refers to source; unsupported edit submits nothing | Edit contract + history/UI test |
| AC13 | Copy one message; regenerate latest complete reply retaining old answer; edit/resend forks prefix without old suffix or orphaned media; next context contains one selected answer | Context/attempt contract + UI path |
| AC14 | Export has model/completion labels, no credentials; media inclusion is honest; Settings states local-only history and uninstall risk; no claimed restorable backup/sync | Export and settings tests |
| AC15 | Changed screens at small/normal sizes, dark/light, large text: keyboard, viewer, sheet and Back order remain usable; loaded images preserve reader position | Real browser interaction and screenshots |
| AC16 | A and B run concurrently; navigation/short background preserves state; interruption/restart shows saved result and no automatic paid retry; account change rejects stale output | Runtime lifecycle tests + device limit check |

### 7.2 Proportionate checks, not a new release bureaucracy

The implementation session first reproduces the failing path or demonstrates
the missing behavior and adds tests that would fail on the old code. Run only
the affected development checks during implementation:

- `pnpm --filter @minih-agent/remote-web exec vitest run <affected-test-files>`
  for local policy, repository, runner and presentation regressions. Add the
  browser path where Node-only tests cannot prove UI or IndexedDB behavior.
- `pnpm --filter @minih-agent/remote-web typecheck` and the affected web/native
  build. Build changed shared packages before consumers of their `dist`.
- Changed-file lint using this repository's actual tool configuration; avoid
  inventing an ESLint command for a package without that script.
- When B changes RACP, run affected shared schema, Host and Gateway forwarding
  tests. Reuse `pnpm test:e2e:remote-web` for the changed remote path with its
  packaged local fixtures; it does not by itself cover native direct chat.
- Extend the existing isolated browser harness for the direct path rather than
  a production account. Reuse the provisioned toolchain; isolate profiles,
  ports and artifacts. Do not run `verify:ui:*` or attach the user's running
  desktop without explicit authorization.

Broad release gates run only at a later authorized push/merge stage according
to repository policy. Real iOS/Android camera, save/share, keyboard and
background acceptance must be reported separately as passed, failed, not run
or environment-blocked; no real paid provider calls without permission. A
missing simulator/device blocks that acceptance claim, not unrelated code work.

## 8. Implementation handoff and completion boundary

The named implementation session owns code changes. This design session only
writes these documents and sends the task; it does not commit, push, merge,
deploy or run product tests.

The recipient must recheck its branch/worktree and current source, then adopt
this ADR and linked spec amendments into its own dedicated implementation
worktree. Do not develop in the primary checkout or modify another task's
worktree. This document's source worktree is read-only reference material for
the recipient, not a shared development branch. The handoff includes these
four documentation changes; do not depend on unrelated uncommitted work.
Preserve other edits when adopting the document changes.

Before code, finalize corresponding UX and any new wire/security spec in the
implementation worktree. The bounded choices above are the implementation
brief; no repeated approval is needed for routine details. Permissions beyond
the bounded D6 media read, new server ownership, missing authoritative Router
metadata, third-party download privileges or paid-service tests are not routine
details. Report concrete blockers and continue unblocked work.

Delivery reports name the implemented phase and report item, changed files,
actual tests/device checks, schema compatibility and remaining limits. They
must distinguish code complete, installed, deployed and device accepted. Do
not claim all 24 report items are finished while remote deletion, backup/import
or sync remain explicitly deferred. No calendar estimate is asserted without
implementation evidence.
