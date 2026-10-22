# ADR: Mobile direct gateway chat alongside remote computers

- Status: Accepted
- Date: 2026-10-21
- Scope: Native iOS and Android builds of `apps/remote-web`; the browser build is unchanged.
- Related: [ADR 0331](0331-self-hosted-gateway-and-mobile-client.md),
  [Router-account remote control](remote-control-router-account-binding.md),
  [Mobile client UX](../spec/04-ux/13-remote-mobile-client.md),
  [Router provider configuration](../spec/03-runtime/12-provider-config-schema.md),
  [Configuration synchronization](../spec/03-runtime/22-config-sync.md).
- Visual reference: `apps/remote-web/design/prototype/direct-chat.html` (simulated data).

## Context

The phone should start an independent conversation, connect directly to the
model gateway, and switch models without a computer running or approving the
phone. It should use the existing mobile chat panel and have a clear home for
its conversation history.

There are two different gateways in this product:

| Service | Existing responsibility | Direct chat responsibility |
|---|---|---|
| Minih-Router, the model gateway | AccessKey authentication, model routing, inference, quotas and usage | Receives the phone's model requests directly |
| `apps/remote-gateway`, the remote-control Gateway | Computer discovery, device grants, RACP relay and remote notifications | None; it does not become a conversation server |

Current source was inspected at Desktop `1816fa40d` and local Router
`bc82e062` on 2026-10-21. These are source observations, not deployment checks:

| Finding | Evidence |
|---|---|
| Mobile is one React application inside Capacitor 8, with iOS and Android projects | `apps/remote-web/package.json`; `capacitor.config.ts` |
| With no registered computer, the whole app is the computer connection screen | `apps/remote-web/src/App.tsx`, `hostList` |
| Navigation is one stack, `hosts → projects → projectSessions → session`, plus `pair` / `account`; one pure `previousScreen` serves header Back, Android Back, browser history and the iOS edge swipe | `src/lib/screen-stack.ts`; `src/lib/screen-history.ts` |
| The UX spec forbids a tab bar and reaches Settings (S8) from S4; S8 is specified but not in the current `Screen` union | Spec §4, §15.7; `src/screens/HostsScreen.tsx` (trailing action is Add only) |
| Chat presentation already has separable timeline, composer and scroll pieces | `src/components/chat/ChatTimeline.tsx`; `ChatComposer.tsx`; `src/hooks/useTimelineScroll.ts` |
| The session screen and its hook require Host identity, device credentials and RACP | `src/screens/SessionScreen.tsx`; `src/hooks/useSessionScreen.ts`; `src/lib/host-client.ts` |
| Phone persistence holds computer registrations and view metadata, not transcripts | `src/lib/host-registry.ts`; `src/lib/session-state.ts` |
| Remote account login uses the AccessKey once and discards it | `src/lib/account-client.ts`; `src/lib/account-flow.ts` |
| Secure-store reconciliation only touches `device-token.*` items, so another prefix is left alone | `src/lib/secure-store.ts`, `hostIdFromKey`; `src/lib/native-credential-port.ts`, `ready` |
| `CapacitorHttp` ships in `@capacitor/core` 8.5.3 (with `disableRedirects`) but is neither enabled nor used | `@capacitor/core` `types/core-plugins.d.ts`; `capacitor.config.ts` |
| Native CSP permits only the baked remote-control Gateway origin | `src/lib/csp.ts`; `apps/remote-web/vite.config.ts` |
| `GET /api/auth/session` returns `access_key_id`, key name, prefix/suffix, status and `allowed_peer_cidrs`; rotation keeps the key id | Router `internal/control/auth.go`, `handleAuthSession`; `internal/control/access_key_rotation.go` |
| `/api/models` declares per-model protocols; `/v1/models` also lists Responses, image and embedding models | Router `internal/control/project_model_collection.go`; `internal/gateway/models.go`, `modelListProtocols` |
| Configurable downstream CORS applies to `/v1` and `/v1beta`, not `/api` | Router `internal/gateway/downstream_headers.go`, `isDataPlaneNamespacePath` |
| A key with `allowed_peer_cidrs` is rejected from other networks | Router `internal/gateway/auth.go` |

## Decision

### 1. Two roots in one stack: Chats and Computers

The native app gains a second root. The browser build keeps today's single
remote hierarchy and shows neither a tab bar nor Chats.

```text
Native app
├── Chats (root, D1)                   no computer required
│   ├── Connect model gateway (D2)
│   ├── Conversation (D3) ── model sheet · info sheet
│   └── Archived (D4) ── Conversation (D3)
├── Computers (root, S1 empty / S4)    existing remote workflow, unchanged below
│   └── S2 / S3 · S5 ▸ S5b ▸ S6
└── Settings (S8, pushed from either root)
    └── Model gateway · Chat history · (remaining S8 sections when implemented)
```

| ID | Page | Entry | Back goes to |
|---|---|---|---|
| D1 | Chats: search, pinned, recent, Archived link | Tab; launch | Exits the app (root) |
| D2 | Connect model gateway | D1 empty state; New chat without a key; S8 | Where it was opened from |
| D3 | Conversation | D1 or D4 row; New chat | D1, or D4 when opened from it |
| D4 | Archived conversations | D1 footer link | D1 |
| S8 | Settings | Gear on D1 or S4 | The root it was opened from |

- **One stack, two possible roots.** Add `chats`, `chat`, `chatArchive`,
  `modelGateway` and `settings` to `Screen`. `previousScreen` stays pure and
  returns `null` for both `chats` and `hosts`; a pushed page records the origin
  it must return to, as `projectSessions.viaProjects` already does.
- **The tab bar shows on the two roots only** (D1, and S1/S4). It is hidden on
  every pushed page, so the conversation viewport is unchanged. Switching tabs
  replaces the root (`replaceState`); Back never alternates between tabs and
  Android Back on either root exits. Because tabs are only reachable from a
  root, there is no hidden per-tab stack to keep or restore.
- **Launch.** A fresh install opens Chats. The first launch after upgrading an
  installation that has computers opens Computers. Afterwards the app reopens
  the last selected root (a small, credential-free local preference). A pushed
  conversation is not restored across a cold start.
- **S1 Connect becomes the empty state of the Computers tab**, not a gate on the
  whole app. An empty registry, failed pairing, remote Gateway outage or missing
  device token never blocks Chats, and a direct-history failure never blocks
  Computers.
- **Notifications stay computer-owned.** A tap replaces the root with Computers
  and restores S4 ▸ S5 ▸ S6 exactly as today. The in-progress direct draft is
  already persisted, so nothing is lost.
- **Settings** is one page pushed from the gear on either root. The first
  release adds two sections — Model gateway (account, unlink) and Chat history
  (local-storage note, clear, read-only older account scopes); the remaining S8
  sections follow when S8 itself is implemented.

This amends UX spec §4 (single stack, no tab bar), §15.7 (S8 reached from S4
only) and §17.3 (launch). Direct chat does not add a fictitious computer,
project, Agent mode or permission mode to fit RACP. A computer-attention badge
on the Computers tab and the tablet split view (§11) are deferred.

### 2. Keep model access separate from remote computer access

A model connection is a device-local record: canonical gateway root, label,
verified `access_key_id`, credential reference, last model choice and a
credential-free catalog cache. The first release exposes one connected model
account at a time; retained history may still belong to an earlier account.

- The model gateway is a build-time HTTPS origin of the current brand,
  separate from `VITE_GATEWAY_ORIGIN` (the remote-control service). A shared host
  does not make their paths or credentials interchangeable. Arbitrary runtime
  gateway origins are outside the first release.
- D2 verifies the key with Router `GET /api/auth/session`. Account identity is
  gateway root plus `access_key_id`, never the key text or a hash. Rotation keeps
  the id, so a rotated key updates the credential without splitting history; a
  different id is a different history scope. When `allowed_peer_cidrs` is
  non-empty, D2 warns that the key may be rejected on mobile networks.
- The AccessKey is stored through the existing secure-storage adapter under its
  own prefix, never in `device-token.*`, UI state after setup, IndexedDB,
  localStorage, URLs, copied text or logs. Unlinking removes the secret and
  stops requests; the conversations stay readable and are deleted separately.
- Remote account sign-in keeps discarding its AccessKey; D2 states that this
  key is saved on the phone. The direct service never presents an AccessKey as a
  Host credential, and a device token cannot call the model API. The key's
  existing account powers stay as the remote-control account decision defines.

Transport is confined to the configured origin:

- **Control plane** (`/api/auth/session`, `/api/models`) is non-streaming and
  goes through `CapacitorHttp.request` called directly with redirects disabled.
  The global fetch/XHR patch stays off. Native HTTP is not subject to CSP, so the
  request service itself rejects any other origin.
- **Data plane** (`/v1` streaming) uses WebView `fetch` with a stream reader and
  `AbortController`. Native `connect-src` adds exactly the model gateway origin;
  no wildcard, TLS bypass or remote-control proxy.
- The model gateway operator must allow `capacitor://localhost` and
  `https://localhost` on `/v1` for requests and preflights with `Authorization`
  and `Content-Type`. Router already has this setting; deployment state is
  unverified.

### 3. Switch models within a conversation

Router's key-scoped, paginated `/api/models` supplies executable client model
ids and declared protocols. Reuse the desktop catalog parsing rules by moving
the Node-free parser/types into `packages/shared` if needed; mobile must not
import Electron code or implement billing rules.

- The first release supports text over **Chat Completions** and **Responses**:
  prefer `openai-completions`, else `openai-responses`. Other models appear
  disabled with a reason; image and embedding models are not chat choices. Do
  not guess capability from model names or retry another protocol silently.
- The model chip in the composer opens the model sheet (search, gateway as the
  source). A new chat starts with the account's last explicit supported choice;
  if it is gone, the user picks one rather than being moved to another paid model.
- A conversation remembers its model. Changing it is allowed only while idle,
  applies to the next send and keeps the thread. Each reply attempt saves the
  model id, protocol and any reasoning level, so earlier replies keep their
  labels. Reasoning levels appear only when verified metadata supports them.
- A vanished or forbidden model keeps history readable and explains why sending
  is unavailable, with the same model sheet as the remedy.

Each request carries the completed user/assistant exchanges plus the new user
message; partial, failed or stopped replies are never context. History does not
depend on provider-side conversation ids or `previous_response_id`. On context
overflow, keep the transcript and draft and offer a new chat; automatic
summarization and silent truncation are outside this decision.

### 4. The phone owns direct history

A versioned IndexedDB database in the app's persistent WebView store owns direct
conversations only. Transcripts never go to localStorage, the computer registry,
host-core SQLite, Router logs or the remote-control Gateway. Host-core remains the
exclusive owner of desktop SQLite; this is a separate mobile repository, not a
move of desktop persistence into a renderer. The raw IndexedDB API is enough; no
new dependency is required.

| Record | Minimum persisted facts |
|---|---|
| Conversation | Local UUID, model-account scope, title, created/updated time, pinned, archived, next-send model/settings, draft |
| Message | Id, conversation id, order, role, text, created time |
| Reply attempt | Id, user/assistant message ids, model/protocol/settings snapshot, state, safe error and usage details |
| Model connection | Gateway root, `access_key_id`, label, secret reference, cached model summaries; never the AccessKey |

Attempt states are pending/streaming, complete, stopped, interrupted and failed.
They are projected into the shared timeline without inventing RACP events or
remote session ids.

- A conversation enters history with its first saved user message; an abandoned
  empty chat leaves no row. The initial title comes from that message; renaming
  is manual and costs no model call.
- D1 lists the current account's conversations: pinned first, then by last
  activity. Search filters titles and saved text in place. Archived ones move to
  D4 and can be restored intact. Older account scopes are read-only, reached from
  Settings, and are never sent under the new account.
- Drafts are per conversation. Delete confirms and removes the conversation,
  messages, attempts and draft together; an active reply must be stopped first.
  Clear history is a separate, scope-labelled action in Settings.
- The first release offers **Copy as Markdown** (clipboard) instead of a system
  share sheet, which would need a new Capacitor plugin. Copied text carries model
  labels and completion markers, never credentials or request payloads.
- Saved history works offline and survives restart and upgrade, subject to
  WebView storage durability. Upgrades are transactional and never recover by
  deleting the database. A storage failure is shown as one.

There is no cross-device sync, automatic backup or desktop continuation, and
transcripts are not added to configuration backup. Uninstalling or clearing app
data can lose history. Content relies on the app sandbox and OS data protection,
not a new encrypted archive. Sync would need its own decision on a transcript
service, ownership and conflict/deletion rules; Router usage logs cannot supply it.

### 5. Reuse the chat view, not the Host orchestration

`SessionScreen` / `useSessionScreen` stay the remote container. D3 is a direct
container over the local repository and a direct request service; both render the
same presentation pieces.

| Reuse | Required separation |
|---|---|
| `ChatTimeline`, Markdown/HTML rendering, scroll and follow | Direct records project to timeline rows; no RACP cursor or Host attach |
| `ChatComposer` layout, keyboard and send/stop affordance | Its send payload type leaves `useSessionScreen`; remote ids and idempotency stay remote; attachments are hidden in D3 |
| Model-list presentation from the new-session and info sheets | Items do not require a Host provider id; remote and direct selection policy stay separate |
| `Screen`, `NavBar`, `Sheet`, banners and theme tokens | D3's header, info sheet and actions use direct capabilities only |

No copied chat panel, generic agent backend, or source-kind switch inside every
shared component; no reuse of remote mutation, cursor or reconnect policy.

```text
apps/remote-web/src/
  components/chat/     existing presentation, narrow shared prop/type changes
  screens/             D1–D4 and the Settings page
  lib/direct-chat/     records and repository, context assembly, request service
```

The request service belongs to the app runtime, not the mounted screen. It pins
account, conversation, attempt and model before awaiting the network, so leaving
D3 or visiting Computers keeps the reply running. Each conversation runs its own
generation with its own Stop, and several conversations may generate at once
with no app-wide cap; within one conversation a new send waits until its reply
ends. D1 marks every conversation that is receiving a reply, so no paid request
runs out of sight. Account change or unlink stops all of them.

### 6. Make saving and interruption explicit

- Save the user message and a pending attempt atomically **before** the request;
  if that fails, keep the draft and send nothing. Coalesce streamed text into
  checkpoints, flush on completion, stop and app deactivation, and mark attempts
  left in progress as interrupted at startup. A killed process may lose the last
  unflushed tail, never an accepted user message, and never shows a false
  completion.
- Stop aborts the local request and keeps the received text as stopped. It is not
  RACP `turn/stop` and cannot promise the upstream stops billing at once.
- Backgrounding does not cancel a reply. Checkpoints are flushed on
  deactivation, and iOS asks the system for extra background time while any
  reply runs, ending that request when the replies end. When the system
  suspends the app or the connection drops, the attempt keeps its checkpoint and
  becomes interrupted. There is no remote continuation or resumable cursor;
  returning shows the saved output with an explicit Retry, never an automatic
  paid re-request.
- Retry is a new attempt for the same user message, without duplicating it; the
  old partial reply stays visible and labelled. Stale events after stop, account
  change or disposal are dropped.
- A persistence failure mid-stream stops the request, keeps visible text
  copyable and reports the failure. Authentication, quota/rate, network-range,
  model availability and transport errors keep distinct reasons and the user's text.

Direct chat has no completion push or background-execution guarantee; computer
notifications keep their current behavior.

## Alternatives

| Option | Entry and reuse | History | Main trade-off |
|---|---|---|---|
| **Chosen: two roots, local direct service** | Clear no-pairing entry; reuses the mobile panel | Phone-owned; copy out; no sync | Adds local persistence and mobile lifecycle handling |
| Direct-chat button inside a computer or project | Small change | Ambiguous owner | Implies a computer dependency; hidden when none is paired |
| One merged list of local and remote conversations | One list, one New action | Two authorities, two credentials | Offline, delete and continuation rules become hard to explain |
| One generation app-wide; cancel on backgrounding | Simplest state, no hidden spend | Unchanged | Blocks a second conversation and kills a reply on any app switch; replaced on review |
| Per-tab stacks with an always-visible tab bar | Jump between a chat and a computer in one tap | Unchanged | Costs timeline height and complicates the single Back rule; revisit with usage evidence |
| Router CORS on `/api/auth/session` and `/api/models` | One transport (WebView fetch) | Unchanged | Removes native HTTP, but changes Router's control-plane exposure; Router-side decision |
| Conversation storage in the remote Gateway | Could reuse RACP calls | Server-owned, shareable | Turns the relay into a data service with a new contract |
| Always-on `agent-host-cli` on a server | Reuses all remote UI and history | Host-owned | Operating a Host is a different product from direct chat |

## Consequences

- Direct text chat works with every computer off and no device grant, in the
  same visual language; remote sessions and their history are unchanged.
- Work stays in the Desktop repository. Router needs no new endpoint or field;
  its `/v1` CORS configuration must allow the two native origins.
- The phone now holds a model AccessKey and conversation content, so secret
  separation, account scoping, failure-safe saving and native streaming are core
  requirements, not follow-ups.
- History does not reach other devices. A reply survives a short trip to the
  background, but not a long one: iOS grants roughly half a minute and Android
  gives no guarantee, so a long absence still ends as interrupted. Keeping a
  reply through a long absence needs an Android foreground service or
  gateway-side generation, each its own decision.
- Deferred: browser direct chat, arbitrary gateways, attachments, tools, MCP,
  skills, Agent/Plan/Goal, voice, share sheet, summarization, tablet split view,
  a Computers attention badge and cross-device sync.

## Follow-up

1. UX spec §4, §15.7 and §17.3 (and the Chinese mirror) carry the two roots;
   the D1–D4 and Settings details are still only in this record and the
   prototype, and belong in the UX spec.
2. The three stages are implemented: roots and presentation seams; model
   connection, catalog and streaming; durable history and interruption
   handling, with sending wired only after history saving.
3. Still unverified: streaming, CORS preflight, Keychain/Keystore separation
   and background behavior on each shipped platform against a local or staging
   gateway; real paid model calls need their own authorization.
