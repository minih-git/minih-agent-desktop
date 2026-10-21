# 13. Remote Mobile Client UX

- Status: **Accepted design, partially implemented, extended by §15.** Decisions
  O1–O6 resolved on 2026-10-19 (section 14) and R7-1–R7-3 on 2026-10-21
  (section 15.10). Sections 1–14 are the accepted design of record; §15 is the
  R7 revision and is now **decided and being implemented**, covering the
  capabilities that appeared after this document was written (choosing a model,
  sending images and files, per-session model and mode, settings, and tool calls
  that read as actions rather than output). Where §15 and §8 disagree, §15 wins.
  §17 is a further proposal (awaiting approval) that replaces §8.6's project
  grouping with two pages of navigation, unifies the status vocabulary, and
  designs notifications; where it disagrees with §8 or §15, §17 wins once
  approved.
  Implemented today: S1–S6 as described here, S6's Markdown answers, the
  project-grouped session list, and the tool-call presentation of §15.11; the
  clickable prototype `apps/remote-web/design/prototype/index.html` (open the
  file directly; data is simulated) is the visual reference and was reviewed at
  320×568 through 430×932; `apps/remote-web/design/prototype/projects-notifications.html`
  is the second prototype, for the §17 proposal only.
- Scope: `apps/remote-web`, i.e. the browser (H5) build and the Capacitor iOS
  and Android builds. They share one React codebase, so every rule here applies
  to all three unless a section names a platform.
- Related: [ADR 0331](../../adr/0331-self-hosted-gateway-and-mobile-client.md),
  [remote-control rollout R6](../06-delivery/07-remote-control-rollout.md),
  [remote control protocol](../03-runtime/19-remote-agent-control-protocol.md),
  [desktop design system](07-ui-design-system.md).
- Non-goals: protocol, Gateway, or credential-storage changes. This document
  only redesigns presentation and interaction on top of the existing client
  logic (`src/lib`, `src/hooks`).

## 1. Purpose

The remote client lets a person supervise agent work that keeps running on
their own computer. It is not a second desktop. The phone is used in short,
interrupted moments, usually after a push notification, often one-handed. The
current screens were built to prove the protocol end to end; they expose every
state correctly but present it as a stack of identical bordered cards with
desktop-sized text controls. This specification turns the same capabilities
into a coherent mobile product.

## 2. Current-state audit

Findings from the installed iOS build (Gateway `rc.hmini.org`, 2026-10-19) and
source at `origin/main`:

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| D1 | Horizontal page padding is zero; cards and header actions touch the screen edges | `.app-safe-area` is unlayered CSS, so its `padding-left/right: env(...)` (0 on a portrait iPhone) overrides the layered Tailwind `px-3` / `px-2` | Looks broken; text sits against rounded screen corners |
| D2 | A tall empty gap under the header | The same class is applied to both `header` and `main`: the header also receives the bottom (home-indicator) inset, `main` receives the top inset a second time, and both replace the `py-*` utilities | Wastes roughly 80 pt of the first screen on a notched iPhone |
| D3 | No first-run experience | An empty Host list shows one sentence plus a second card for account sign-in | The user cannot tell which path to take or what the app is for |
| D4 | Two competing primary actions | "Add host" (ticket pairing) sits in the header as the only filled button, while account sign-in, the easier path, is a secondary button lower down | The recommended path looks secondary |
| D5 | Every surface is the same card | Timeline messages, tool calls, approvals, banners, and lists all use `Card` with the same border and radius | No hierarchy; conversations read as forms |
| D6 | Equal-weight destructive controls | Stop and Interrupt sit side by side; Forget sits next to Open in every row | Easy to trigger the wrong action |
| D7 | Inconsistent vocabulary | zh-CN uses both 主机 and 电脑 for the same thing; protocol terms such as 回合, 幂等键, 票据 reach end users | Feels technical and unfinished |
| D8 | Visual identity detached from the desktop | Blue-slate Tailwind palette and a `#0b0f14` splash, while the desktop uses a neutral gray system | The two products do not look related |

D1 and D2 are layout defects and are fixed first regardless of the rest of
this redesign (section 6.1).

## 3. Users, jobs, and principles

Primary user: the owner of one or more computers running Minih, away from the
desk. Jobs, in order of frequency:

1. Answer what the agent is waiting for — a tool approval or a question —
   usually straight from a notification.
2. Glance at whether work is still running, finished, or failed.
3. Steer: send a follow-up message to a running or idle session.
4. Stop a turn that is going the wrong way.
5. Connect this phone once (account sign-in or pairing ticket).
6. Occasionally manage computers: refresh, re-request access, forget.

Design principles:

- **Decisions first.** Anything waiting for the user is the most prominent
  element on whichever screen it appears, and reachable with the thumb.
- **Calm by default.** Normal states carry no banners or color. Color appears
  only for status semantics and never on its own (always with a label or shape).
- **One primary action per screen.** It is a full-width filled button anchored
  to the bottom thumb zone; everything else is secondary, text, or in a sheet.
- **Destructive actions are one step away.** They live in action sheets with a
  confirmation, never next to the primary action.
- **Same family as the desktop.** Neutral gray surfaces, ink-colored primary
  actions, the desktop's status colors, and the same icon library.
- **Honest connectivity.** The user always knows whether what they see is live,
  and the app never implies an action happened before the Host confirms it.

## 4. Information architecture and navigation

Navigation is a single push stack, no tab bar: the product has one hierarchy
and a tab bar would waste vertical space on a timeline screen.

```text
Launch
 ├─ no computers ─▶ S1 Connect
 │                   ├─ S2 Account sign-in ─▶ S2a Request device ─▶ S2b Waiting ─▶ S2c Result
 │                   └─ S3 Pairing ticket
 └─ computers ────▶ S4 My computers
                     ├─ (+) action sheet ─▶ S2 / S3
                     ├─ (⋯) computer sheet: refresh · ask again · forget
                     └─ S5 Sessions ─▶ S6 Session (timeline + decision dock + composer)
Push tap ──────────▶ S6 Session, with S4 ▸ S5 restored beneath it
```

| ID | Screen | Entry | Replaces |
|---|---|---|---|
| S0 | Launch and boot failure | App start | `BootFailure` |
| S1 | Connect | No stored computers | Empty `HostsScreen` |
| S2 | Account sign-in flow | S1 or the (+) sheet | `AccountScreen` |
| S3 | Pairing ticket | S1, S2 fallback, or the (+) sheet | `PairScreen` |
| S4 | My computers | Launch with at least one computer | `HostsScreen` |
| S5 | Sessions of one computer | Tap an online computer | `SessionsScreen` |
| S6 | Session | Tap a session, or a push | `SessionScreen` |
| S7 | Sheets and dialogs | Contextual | Inline confirm rows |

Back behavior — one rule, four paths: the header back control, the Android
hardware back button, the browser's own Back, and the iOS edge swipe all pop
exactly one level through `previousScreen` (`src/lib/screen-stack.ts`), so they
cannot disagree.

- **The browser's history is the stack.** Every forward navigation writes one
  entry (`src/lib/screen-history.ts`: `pushState` for a new level,
  `replaceState` for the level already shown), and `popstate` adopts the screen
  the entry names — or, for an entry written by an older build, falls back to
  `previousScreen`. A browser Back and Safari's edge gesture therefore step up
  one level instead of leaving the site, a Forward returns to the entry it
  names, and the entry the user arrived on is replaced rather than stacked.
- **iOS uses this client's own edge gesture, not the WebView's.** Capacitor's
  `allowsBackForwardNavigationGestures` is deliberately left off: it shows a
  static snapshot of the page it returns to, while a session screen is live —
  a stream, a pending decision, a running turn — so the snapshot and the state
  would visibly disagree, and the gesture would also drive the history
  underneath the app's own sheet state. `src/hooks/useEdgeSwipe.ts` instead
  tracks a drag and calls the same back path, so there is one behaviour to
  reason about. Its rules: a touch must start within `EDGE_WIDTH` (20 px) of the
  left edge; a mostly-vertical or leftward drag is released untouched, which is
  what keeps the timeline's scroll and a code block's horizontal pan working; the
  screen follows the finger with the page beneath at a third of the distance; on
  release it completes past `COMPLETE_FRACTION` (1/3 of the width) or a flick
  past `COMPLETE_VELOCITY` that has travelled at least
  `MIN_FLICK_DISTANCE_FRACTION` (15%), and otherwise springs back. A gesture
  starting off the edge, with nowhere to go, or while a sheet is open
  (`[role="dialog"][aria-modal="true"]` is present) is never intercepted.
- **A browser never mounts the JS gesture.** It already has one, and running both
  would pop two levels per swipe.
- **Push restores the stack (§8.8) and the history with it**: opening the named
  session writes the computer's session list as one entry and the session as the
  next, so a back swipe from a pushed session lands on that list rather than on
  the Host list.

## 5. Visual system

### 5.1 Color tokens

Values reuse the desktop token values (`apps/desktop/src/styles/tokens.css`)
so both products read as one family. Names use the `--rm-` prefix because the
remote client does not import desktop CSS.

All status colors match the desktop exactly, including purple for "waiting for
decision" (confirmed by the owner on 2026-10-19), so a session that needs the
user looks the same on both clients.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--rm-bg-page` | `#f3f3f3` | `#181818` | Page background behind grouped content |
| `--rm-bg-surface` | `#ffffff` | `#212121` | Grouped lists, cards, composer field |
| `--rm-bg-raised` | `#ffffff` | `#282828` | Sheets, floating pills, user message bubble in dark |
| `--rm-bg-inset` | `#ededed` | `#0d0d0d` | Code and tool output, user message bubble in light |
| `--rm-text-primary` | `#1a1c1f` | `#ffffff` | Titles and body |
| `--rm-text-secondary` | `#1a1c1f` at 74% | `#ffffff` at 70% | Supporting text, row subtitles |
| `--rm-text-muted` | `#5d5d5d` | `#9b9b9b` | Captions, timestamps, section headers |
| `--rm-text-faint` | `#afafaf` | `#5d5d5d` | Placeholders, disabled glyphs |
| `--rm-separator` | `#1a1c1f` at 8% | `#ffffff` at 8% | Row dividers, hairline borders |
| `--rm-accent` | `#1a1c1f` | `#ffffff` | Primary buttons, send button, focus ring |
| `--rm-on-accent` | `#ffffff` | `#1a1c1f` | Text and icons on the accent |
| `--rm-running` | `#c2410c` | `#ff8549` | Work in progress |
| `--rm-decision` | `#7c3aed` | `#c27aff` | Waiting for an approval or an answer (desktop `--ds-purple`) |
| `--rm-on-decision` | `#ffffff` | `#1a1c1f` | Check marks and glyphs on a `--rm-decision` fill |
| `--rm-success` | `#00802f` | `#40c977` | Online, completed |
| `--rm-error` | `#d42a26` | `#ff6764` | Failed, revoked, destructive actions |
| `--rm-link` | `#1c64c8` | `#63a8f8` | Links inside message text only |

Semantic tints for banners and chips are the semantic color at 10% (light) or
16% (dark) over `--rm-bg-surface`. The theme follows the system appearance;
there is no in-app theme switch. `theme-color` and the native splash use
`--rm-bg-page` for each appearance (replacing `#0b0f14`).

### 5.2 Typography

Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
"Hiragino Sans GB", "Segoe UI", Roboto, "Noto Sans CJK SC", "Microsoft YaHei",
sans-serif`; monospace: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
No web font is shipped (the CSP allows only same-origin fonts and system fonts
render CJK best).

| Role | Size / line | Weight | Use |
|---|---|---|---|
| Large title | 28 / 34 | 700 | S4 title before scrolling, S1 and result headlines |
| Title | 17 / 22 | 600 | Navigation bar title |
| Headline | 16 / 22 | 600 | Row titles, card titles |
| Body | 16 / 24 | 400 | Messages, form fields (16 px prevents iOS focus zoom) |
| Callout | 15 / 22 | 400 | Explanatory text in cards and sheets |
| Subhead | 14 / 20 | 400 | Row subtitles, status lines |
| Footnote | 13 / 18 | 400 | Section headers, helper text, timestamps |
| Caption | 12 / 16 | 500 | Chips, badges, queue counters |
| Mono | 13 / 20 | 400 | Tool names, tool output, ticket and key fields |

All sizes are expressed in `rem` so browser and system text-size settings scale
them. Layout must survive 200% text size without horizontal page scrolling
(code blocks may scroll inside themselves).

### 5.3 Spacing, radius, and sizing

| Token | Value | Use |
|---|---|---|
| Base grid | 4 px | Every spacing value is a multiple |
| Page gutter | `max(16px, env(safe-area-inset-left/right))` | Left and right page padding |
| Section gap | 24 px | Between groups; 8 px between a section header and its group |
| Card padding | 16 px | Grouped rows and cards |
| Row height | 52 px single line, 64 px two lines | List rows |
| Touch target | 44 × 44 px minimum | Every interactive element, including icon buttons |
| Radius control | 12 px | Buttons, inputs, option rows |
| Radius group | 16 px | Cards and grouped lists |
| Radius sheet | 20 px (top corners) | Bottom sheets |
| Radius bubble | 18 px, 6 px on the tail corner | User message bubble |
| Content width | 640 px maximum, centered | Landscape phones, tablets, desktop browsers |

Elevation: in light mode surfaces separate from the page by color alone (no
shadow on cards). Only sheets, the floating "new messages" pill, and the
docked composer cast a shadow: `0 -1px 0 var(--rm-separator), 0 8px 24px
rgba(0,0,0,0.08)` (light) or a 1 px top hairline only (dark).

### 5.4 Iconography

Lucide, as on the desktop (`07-ui-design-system` §7): 20 px with 2 px stroke in
buttons and navigation, 16 px with 1.5 px stroke inline, 48 px with 1.5 px
stroke in empty and result states. Text glyphs (`←`, `↻`) and emoji are not
used as icons. Icons default to `--rm-text-secondary`; status icons use the
status token of section 5.6.

### 5.5 Motion

| Interaction | Duration | Easing | Reduced motion |
|---|---|---|---|
| Press feedback (opacity or scale 0.98) | 120 ms | ease-out | Opacity only |
| Banner, chip, toast enter and exit | 200 ms | `cubic-bezier(0.2, 0, 0, 1)` | Instant |
| Screen push and pop (24 px slide plus fade) | 280 ms | `cubic-bezier(0.2, 0, 0, 1)` | 120 ms crossfade |
| Bottom sheet open and close | 280 ms | `cubic-bezier(0.2, 0, 0, 1)` | Instant |
| Status dot attention | Two 1.6 s cycles, then steady | ease-in-out | Steady |

Only indicators of work in flight (a streaming reply, a running tool row, the
waiting countdown) may animate for as long as the work lasts, matching the
desktop rule in `07-ui-design-system` §4.5.

### 5.6 Status semantics

One vocabulary across computer rows, session rows, the run status bar, and the
timeline. State is never conveyed by color alone.

| State | Token | Shape and motion | Label |
|---|---|---|---|
| Online | `--rm-success` | Filled dot | Online |
| Offline or unreachable | `--rm-text-muted` | Hollow dot | Offline |
| In progress | `--rm-running` | Filled dot, two breathing cycles; spinner on a running tool row | Running |
| Waiting for decision | `--rm-decision` | Filled dot, two pulses | Needs you |
| Completed | `--rm-success` | Check mark | Done |
| Failed or revoked | `--rm-error` | Circled alert mark | Failed / Access revoked |

## 6. Layout shell

### 6.1 Safe areas (fixes D1 and D2)

Safe-area insets are applied exactly once per edge, by the element that touches
that edge, and are combined with — never substituted for — the regular padding:

```css
/* inside @layer utilities so Tailwind ordering stays predictable */
.rm-nav      { padding-top: env(safe-area-inset-top); }
.rm-gutter   { padding-left: max(16px, env(safe-area-inset-left));
               padding-right: max(16px, env(safe-area-inset-right)); }
.rm-dock     { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
.rm-scroll-end { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
```

The navigation bar owns the top inset, the bottom dock (composer, decision
dock, or bottom action button) owns the bottom inset, and a screen without a
dock gives its scroll content `rm-scroll-end`. `main` never receives a
top inset. The `.app-safe-area` class is removed.

### 6.2 Navigation bar

- Height 44 px below the top inset; background `--rm-bg-page` at 92% with
  backdrop blur, a hairline separator that appears only after content scrolls
  under it.
- Leading: back button (chevron-left icon, 44 px target, accessible name
  "Back"). Center: title (Title style, one line, truncated). Trailing: at most
  two 44 px icon buttons.
- S4 uses a large title (28 px) inside the scroll content that collapses into
  the 17 px bar title when scrolled past.
- An optional subtitle line (Footnote, muted) under the title carries context
  such as the computer name on S6. The subtitle is one line: text it carries
  (a computer name is user data of unknown length) truncates, and a trailing
  state marker such as S6's "Live" keeps its own width instead of shrinking, so
  a long name never wraps the fixed-height bar or hides the marker.

### 6.3 Bottom dock and keyboard

The dock is the last child of the screen column and is sticky to the bottom.
When the software keyboard opens, the dock must stay directly above it:
Android and browsers use `interactive-widget=resizes-content` in the viewport
meta; iOS uses the native resize mode of the Capacitor Keyboard plugin (decision
O2). The timeline keeps its scroll anchor at the bottom while the
keyboard animates.

## 7. Components

Components replace the current `Chrome.tsx` primitives. Each is a small module
under `src/components/ui/`.

- **Screen** — column with navigation bar, scroll area, optional dock; owns the
  safe-area rules of section 6.1 and the 640 px content width.
- **NavBar** — section 6.2.
- **Button** — variants `primary` (accent fill), `secondary` (surface fill with
  separator border), `plain` (text only), `destructive` (error text on surface;
  filled error only inside a confirmation sheet). Sizes `large` (52 px,
  full width, used for the one primary action), `medium` (44 px), `icon`
  (44 px square). Loading state replaces the label with a spinner and keeps the
  width; disabled is 40% opacity.
- **ListGroup / ListRow** — grouped inset list on `--rm-bg-surface`, radius 16,
  hairline dividers inset by the leading slot. A row has leading slot (status
  dot or 32 px icon tile), title, optional subtitle, optional trailing (chevron,
  value, or a 44 px "more" button). The whole row is the tap target when it
  navigates.
- **SectionHeader** — Footnote, muted, 16 px horizontal inset, optional
  trailing plain action.
- **StatusDot / StatusLabel** — section 5.6.
- **Banner** — full-width strip under the navigation bar for connection and
  freshness states. Tones neutral, running, error. Optional trailing action.
  At most one banner at a time; precedence error, running, neutral.
- **Callout** — in-content tinted box for a single explanation tied to the
  content around it (for example "this question can only be answered on the
  computer").
- **Sheet** — bottom sheet with grabber, title, and actions; used for action
  menus, confirmations, and the stop choice. Dismiss by tapping the scrim,
  swiping down, Escape, or Android back.
- **Toast** — transient confirmation above the dock for 2.5 s ("Stopped",
  "Forgot MacBook"). Never used for errors that need action.
- **EmptyState / ResultState** — 48 px icon, Large-title or Headline text, one
  Callout paragraph, and up to one primary and one plain action.
- **Skeleton** — static placeholder blocks in `--rm-bg-inset` with a 1.2 s
  opacity pulse (none in reduced motion), shaped like the rows they replace.
- **SecureField / TicketField** — 16 px text, monospace, visibility toggle for
  the AccessKey, trailing "Paste" button for the ticket when
  `navigator.clipboard.readText` is available.

## 8. Screens

### 8.1 S0 Launch and boot failure

- Native splash: centered app mark on `--rm-bg-page`, light and dark variants
  (regenerate assets with the new background colors).
- The splash stays until `boot()` has read credentials; there is no second
  in-WebView loading screen unless boot takes longer than 600 ms, in which case
  a centered spinner appears.
- Boot failure (for example a missing baked Gateway origin): ResultState with
  an alert icon, the title "Minih Remote can't start", the reason, and the note
  that this build needs to be rebuilt. No retry button, because retrying cannot
  help.

### 8.2 S1 Connect

Shown when the registry holds no computers.

- Upper half: 64 px app mark, Large title "Control your agents from your
  phone", Callout "Check progress, approve actions, and keep the conversation
  going. Work keeps running on your computer."
- Three short value rows with 20 px icons: "Approve or deny tool requests",
  "Answer questions the agent asks", "Stop a run that goes the wrong way".
- Bottom dock (thumb zone):
  - Account mode supported: primary large "Sign in with Minih account",
    secondary large "Use a pairing ticket".
  - Account mode not supported or unknown: primary large "Use a pairing
    ticket" only.
  - While the account probe is in flight (normally under 1 s): a skeleton in
    place of the buttons, so the layout does not jump.
- Footer caption with a lock icon: "Connected through rc.hmini.org" (the
  Gateway host; the browser build shows `location.host`).

### 8.3 S2 Account sign-in flow

A three-step flow in one screen with a step indicator under the navigation bar
("Sign in · Request · Confirm"; the current step is ink, the rest muted).

**S2 Sign in.** SecureField "AccessKey" with visibility toggle and helper text
"Used only for this sign-in. It is never stored on this phone." Primary large
"Sign in" in the dock, enabled when the field is not empty. Plain link "Use a
pairing ticket instead". Errors appear under the field as operation plus
reason. Rate limiting turns the button into a disabled countdown ("Try again
in 32 s").

**S2a Request device.** A compact signed-in row ("Signed in as account 1",
trailing plain "Sign out"). Section "Computers on this account" lists each
Host with a status dot and one subtitle line combining availability and
confirmation ability: "Online · can approve this phone", "Online · approves
each device itself", or "Offline". Field "Device name" prefilled with the
platform label. Primary large "Request access for this phone". When no
computer can confirm, an error-toned Callout replaces the list explanation and
the primary action becomes "Use a pairing ticket".

**S2b Waiting.** Centered: a 96 px ring that drains with the remaining time and
shows `mm:ss`, Headline "Approve on your computer", Callout "Open Minih on any
online computer and approve “iPhone”." Below, the roster of computers that were
asked. Plain "Cancel" in the dock. Transient read failures keep the screen and
show a neutral banner "Reconnecting…"; they do not reset the ring.

**S2c Result.** ResultState variants:

- Adopted: success check, "Connected to 3 computers", primary "Open my
  computers".
- Expired: "No computer approved in time", primary "Ask again", plain "Use a
  pairing ticket".
- Lost (approved but token not delivered): "Approved, but the phone didn't
  receive access in time", primary "Ask again".
- Gone: "The Gateway no longer knows this request", primary "Sign in again".
- Failed: "The request didn't go through. Nothing was saved on this phone",
  primary "Try again".

### 8.4 S3 Pairing ticket

- Callout with two numbered steps: "1. On your computer, open Minih remote
  control settings and create a pairing ticket (or run `agent-host-cli
  remote-pair`). 2. Paste the ticket below."
- TicketField, three lines, monospace, trailing "Paste". Validation runs on
  paste and on blur, not on every keystroke: a valid ticket shows a success
  line "Ticket looks right · computer a1b2…"; an invalid one shows the
  existing reason under the field.
- Field "Device name" prefilled with the platform label.
- Primary large "Pair" in the dock; loading state "Pairing…". On success the
  ticket is cleared (existing behavior) and S5 of the new computer opens.

### 8.5 S4 My computers

- Large title "My computers"; trailing (+) icon button opens a sheet: "Sign in
  with Minih account" (only when account mode is supported) and "Use a pairing
  ticket".
- One ListGroup. Row anatomy: leading 32 px laptop icon tile with a status dot
  badge; title = computer label; subtitle = status line; trailing chevron when
  it can be opened plus a 44 px "more" button.
- Status lines: "Online", "Checking…" (skeleton dot), "Offline — Minih isn't
  running or the computer is asleep", "Not synced yet — pull to refresh"
  (or "Approve this phone on that computer" for strict Hosts), "Access
  revoked", "This phone no longer holds access", "Can't connect: reason".
- Tapping an online row opens S5. Tapping a row in another state expands an
  inline Callout with the explanation and its single fix action ("Ask again",
  "Pair again"); it does not navigate.
- More sheet: "Refresh", "Ask again" (unaccepted only), destructive "Forget
  this computer". Forget opens a confirmation sheet with the existing copy and
  a filled destructive button; success shows a Toast.
- Pull to refresh re-probes every computer and replaces the per-row refresh
  buttons. Statuses also refresh when the app returns to the foreground.
- Footer caption: "Gateway rc.hmini.org · access is stored in this phone's
  Keychain" (native) or "… in a secure cookie" (browser).

### 8.6 S5 Sessions

- Navigation title = computer label; subtitle = computer status.
- Grouped by project, the way the desktop sidebar groups them: a project's
  sessions ordered by most recent activity, the projects themselves ordered by
  their most recent session. A session with no project, or with a project the
  catalog no longer holds, falls into one trailing "Other" group, so nothing
  disappears. A project holding no session is not shown, because an empty
  heading is something the user cannot act on. When the project catalog cannot
  be read the list stays flat under "Other" and an amber line says so.
- Row: leading 12 px status slot (section 5.6), title up to two lines (session
  title, falling back to "Untitled session" rather than the raw id), subtitle
  "3 min ago" plus the state word for non-idle states ("Stopped", "Failed").
  Relative time uses `Intl.RelativeTimeFormat`; older than 7 days shows a date.
- Loading: six skeleton rows. Refresh: pull to refresh and on foreground; a
  refresh does not repeat the reachability probe it can answer itself, and it
  reads the project catalog once per visit (both implemented).
- New session: a `controller` device gets "New session" in the section header,
  which opens S5a (§15.2). A device whose recorded roles exclude `controller`
  gets the reason instead of a disabled button; an entry written before roles
  were recorded is treated as unknown and offered.
- Empty: EmptyState "No sessions on this computer yet", Callout "Start a task
  here, or on the computer — it will show up in this list."
- Offline or failed load: error Banner with "Retry"; the last loaded list stays
  visible but dimmed to 60%.
- Offline or failed load: error Banner with "Retry"; the last loaded list stays
  visible but dimmed to 60%.
- Revoked: ResultState "This phone's access was revoked" with primary "Forget
  and pair again".

### 8.7 S6 Session

**Navigation bar.** Back, title = session title, subtitle = computer label.
The title is live: a rename on the computer (the user's own, a generated name,
or a plugin's) arrives as a `session.changed` whose payload carries the session,
so the bar shows the new task name while the reader stays on the screen. The
list on S5 does not subscribe to that stream; it re-reads on foreground and on
pull, per §8.6.

**Connection banner.** Hidden while live. `idle` → neutral "Connecting…";
`retrying` → running "Reconnecting…"; `exhausted` → error "Live updates
stopped" with trailing "Reconnect"; `stopped` → neutral "Disconnected";
`revoked` → the whole screen becomes the S5 revoked ResultState. `paused` is
never shown, because it only occurs while the page is hidden. Resync and
incomplete-replay notices are neutral banners with the existing copy, reworded
per section 10.

**Run status bar.** Sticky under the navigation bar while a turn is active or
queued: status dot and label ("Running", "Needs your approval", "Needs your
answer", "Queued"), a queue chip ("2 queued") when applicable, and a trailing
secondary medium "Stop" button. Stop opens a sheet:

- "Stop after this step" — sends `turn/stop`; the Host finishes the current
  assistant or tool boundary, then ends the turn.
- "Stop now" (destructive) — sends `turn/interrupt`; aborts immediately and
  cancels queued turns.
- "Cancel".

While a request is pending the bar shows "Stopping…" and the button is
disabled. When the turn ends the bar collapses with the 200 ms motion and a
Toast confirms ("Stopped", "Run finished").

**Timeline.**

- User message: right aligned, max 85% width, `--rm-bg-inset` (light) or
  `--rm-bg-raised` (dark) bubble, radius 18 with a 6 px tail corner.
- Assistant message: left aligned, no bubble, full width, rendered as Markdown
  (paragraphs, lists, quotes, headings, inline code, links to http/https/mailto
  only, fenced code in its own horizontally scrolling block, GFM tables in a
  horizontally scrolling wrapper), with no raw HTML and no remote images. A
  partially streamed answer renders what has arrived, including an unterminated
  code fence. Implementation and its checks: §15.5. A small caption "From
  {agent}" precedes messages attributed to a sub-agent.
- Thinking: collapsed disclosure "Thinking" (Footnote, muted, chevron).
- Tool call: a compact row, not a card. A category icon (read, list, search,
  write, edit, command, web, subagent, plan), the tool's short name, one line
  saying what it acted on, and its state mark. The tool's own output is never
  the row's text: it is what a reader opens on purpose. Tapping the row reveals
  that output in Mono 13 inside `--rm-bg-inset`, horizontally scrollable, capped
  at 220 px. The category, the summary and the burst sentence come from
  `packages/shared/src/tool-presentation.ts`, the same functions the desktop
  transcript uses, so the two clients describe one call identically.
- Consecutive tool calls fold into one row: icon, one line ("4 commands, 2 files
  edited, 1 file written", at most three clauses so it stays one line), a count
  of failures when any, and a chevron. Expanding lists each call as the row
  above; expanding one of those shows its output. Two taps is the depth: the
  first answers "what happened here", the second "show me that one". A burst of
  one call is drawn as a plain row with no fold.
- System and compaction notes: centered Footnote between two hairlines
  ("Context compacted").
- "Truncated" marks a shortened item with a Caption chip.
- Turn failure: error Callout at the end of the turn, "Run failed: reason".
- Scroll: the screen opens at the bottom; new content follows only when the
  user is within 120 px of the bottom; otherwise a floating "New messages" pill
  with a down chevron appears above the dock.
- Loading: three skeleton bubbles; empty: muted "No messages yet".

**Decision dock.** When approvals or input requests are pending, a dock card
sits above the composer. Both always remain visible: the card is capped at
`clamp(200px, 100dvh − 400px, 55dvh)` and scrolls internally beyond that, so
on a 568 pt screen the timeline keeps about 110 pt and the composer is never
pushed off-screen. It is the most prominent element on the screen.

Approval card:

- Header: shield icon and title in `--rm-decision` ("Approval needed", "Plan
  approval", "Goal approval"), risk chip (low neutral, medium running, high
  error), and "1 of 3" with previous/next chevrons when several are pending.
- Body: tool name (Mono), summary (Body, up to eight lines with "Show more"),
  sub-agent attribution, and a live expiry line in whole minutes ("Expires in
  5 min"), switching to seconds in the final minute ("Expires in 45 s"). An expired request turns read-only with "Expired".
- Actions: two equal medium buttons in one row — secondary destructive
  "Deny"/"Reject" on the left, primary "Allow once"/"Approve" on the right.
  More than two decisions stack vertically, primary last.
- High risk: an error-toned line "High risk — check the details before
  allowing", and the primary decision opens a confirmation sheet that repeats
  the tool name and summary (decision O4).
- Pending: the tapped button shows a spinner and both are disabled; a failure
  appears inline below the buttons and retrying reuses the same attempt key
  (existing behavior).
- "Allow for this session is only available on the computer" stays as a
  muted caption when the Host offered that decision.

Input card:

- Header: question icon and "The agent has a question" in `--rm-decision`.
- One question per step when there are several ("Question 1 of 3", "Next",
  "Back"); a single question shows directly.
- Options are full-width 48 px rows with a radio or checkbox mark;
  multi-select questions show the caption "Choose any". "Skip this question" is
  a plain button. Primary "Send answer" on the last step.
- Questions without options keep the Callout "Answer this on the computer".

**Composer.** Pill field (radius 22, `--rm-bg-surface`, separator border) with
an auto-growing textarea of one to six lines, placeholder "Message the agent",
and a trailing 36 px circular send button in `--rm-accent` with an arrow-up
icon. The button is disabled while empty and shows a spinner while sending.
Above the field, Footnote hints: "Your computer is busy — this message will
queue" while a turn is active, or in `--rm-error` "Didn't send. Tap send to
retry" after a failure. An archived session replaces the composer with a muted
bar "This session is archived and read-only".

### 8.8 S7 Push entry

Tapping a notification opens S6 for the named session with S4 and S5 restored
beneath it, scrolled to the decision dock. If the decision was already handled
elsewhere, a Toast says "Already handled" and the timeline shows the outcome.
An unknown computer or missing ids open S4 (existing behavior).

## 9. Cross-cutting behavior

- **Errors.** Every user-visible failure names the operation and the reason
  (existing `failureText`). Placement: field-level errors under the field,
  screen-level failures in the Banner, action failures inline next to the
  action. Never in a Toast.
- **Optimism.** No optimistic success. A sent message appears as a pending
  bubble (60% opacity, small clock icon) until the Host echoes it; approvals
  stay pending until the Host resolves them.
- **Foreground refresh.** Returning to the app re-probes computer status and
  resumes the session stream (existing `visibilitychange` handling); the UI
  shows the neutral "Connecting…" banner only if resuming takes longer than
  800 ms.
- **Accessibility.** Contrast at least 4.5:1 for text and 3:1 for status
  shapes; every icon button has an accessible name; focus moves to the
  navigation title after each push and pop; turn status changes are announced
  through a polite live region; a newly arrived approval is announced once;
  streaming text is not announced token by token; option rows expose radio or
  checkbox roles; all gestures (pull to refresh, swipe to dismiss) have a
  button or menu equivalent.
- **Reduced motion and transparency.** Section 5.5; the navigation bar blur
  becomes an opaque fill when `prefers-reduced-transparency` is set.
- **Privacy.** No AccessKey, ticket, or token appears in screenshots of result
  states, Toasts, or logs; secure fields disable autocomplete, autocorrect, and
  spellcheck (existing behavior is kept).

## 10. Copy and vocabulary

Rules: say "computer" (zh-CN 电脑), not "host"; avoid protocol words (turn,
idempotency key, cursor, ticket token) in user-facing text; keep sentences
short; state what happened, then what to do. All nine shipped locales receive
the new keys; zh-CN and en below are normative, the others are translated from
en.

| Key | Current (zh-CN) | Proposed (zh-CN) | Proposed (en) |
|---|---|---|---|
| `hosts.title` | 主机 | 我的电脑 | My computers |
| `hosts.add` | 添加主机 | 连接电脑 | Connect a computer |
| `hosts.empty` | 还没有主机。用主机打印的配对票据添加一个。 | (replaced by S1) | (replaced by S1) |
| `connect.title` | (new) | 在手机上接管你的 Agent | Control your agents from your phone |
| `connect.subtitle` | (new) | 查看进度、批准操作、继续对话。任务仍在你的电脑上运行。 | Check progress, approve actions, and keep the conversation going. Work keeps running on your computer. |
| `account.entry` | 使用 AccessKey 登录 | 使用 Minih 账户登录 | Sign in with Minih account |
| `account.keyNotStored` | 该 key 只留在本页内存中，登录成功后即被丢弃。 | 仅用于本次登录，不会保存在手机上。 | Used only for this sign-in. It is never stored on this phone. |
| `pair.title` | 配对主机 | 使用配对票据 | Use a pairing ticket |
| `hosts.status.offline` | 离线 | 离线 · Minih 未运行或电脑已休眠 | Offline — Minih isn't running or the computer is asleep |
| `session.turn.running` | 回合进行中 | 运行中 | Running |
| `session.turn.waiting_approval` | 等待授权 | 等你批准 | Needs your approval |
| `session.turn.failed` | 回合失败：{{reason}} | 运行失败：{{reason}} | Run failed: {{reason}} |
| `session.stop` | 停止 | 停止 | Stop |
| `session.stopAfterStep` | (new) | 完成当前步骤后停止 | Stop after this step |
| `session.interrupt` | 中断 | 立即停止 | Stop now |
| `composer.queueHint` | 当前有回合在运行，这条消息会排队。 | 电脑正在运行，这条消息会排队。 | Your computer is busy — this message will queue. |
| `composer.retryHint` | 发送失败。重试会复用同一个幂等键。 | 发送失败，点按发送重试。 | Didn't send. Tap send to retry. |
| `input.title` | 需要回答 | Agent 有个问题 | The agent has a question |

## 11. Responsive behavior

- **Phones, portrait (320–430 px):** the layouts above. At 320 px the two
  decision buttons may stack.
- **Phones, landscape:** content width 640 px centered; the run status bar and
  dock stay full width; the S1 brand block moves left of the actions when the
  height is below 480 px.
- **Tablets (768 px and wider):** S5 and S6 become a split view (sessions
  320 px on the left, the session on the right); S4 stays a single column
  (phase 4).
- **Desktop browsers (H5):** a 640 px centered column on `--rm-bg-page`; no
  pull to refresh (a refresh icon button appears in the navigation bar
  instead); hover states use a 4% ink wash.

## 12. Implementation plan

The redesign touches presentation only. `src/lib` and the hooks keep their
contracts; new pure helpers (relative time, session grouping, countdown
formatting, banner precedence) get Vitest unit tests next to them.

| Phase | Scope | Files | Exit |
|---|---|---|---|
| 1 Foundation | Tokens, safe-area fix, typography, icons, UI primitives | `styles.css`, `components/ui/*`, `index.html` viewport meta, splash assets | D1, D2, D8 fixed; existing screens restyled through the primitives |
| 2 Connect and computers | S1, S2 flow, S3, S4 with sheets and pull to refresh | `screens/ConnectScreen.tsx`, `AccountScreen.tsx`, `PairScreen.tsx`, `HostsScreen.tsx`, locales | D3, D4, D6 (Forget), D7 fixed for these screens |
| 3 Sessions and session | S5 grouping, S6 navigation, banners, run status bar, stop sheet, timeline, decision dock, composer, push entry | `SessionsScreen.tsx`, `SessionScreen.tsx`, `Timeline.tsx`, `ApprovalCard.tsx`, `InputCard.tsx`, `Composer.tsx`, locales | D5, D6 (Stop) fixed; E2E-266 screenshots updated |
| 4 Enhancements | Cross-computer "Needs you" section on S4, markdown subset in messages, tablet split view, QR pairing, haptics | Separate changes, each with its own decision | Each enhancement accepted on its own |

Each phase is a separate change that keeps the client buildable. New TS/TSX
modules stay under about 500 lines (`AGENTS.md` §7); `HostsScreen.tsx` is split
rather than grown.

## 13. Acceptance criteria

| Dimension | Cases |
|---|---|
| Viewports | 320×568, 375×667, 390×844, 430×932, 844×390 landscape, 820×1180 tablet, 1280×800 browser |
| Appearance | Light and dark on every screen; contrast floors of section 9 |
| Locales | zh-CN, en, and de (longest strings) with no clipped or overlapping text |
| Text size | 100% and 200%; no horizontal page scroll |
| States | Every state named in section 8 rendered at least once, including revoked, unaccepted, expired approval, rate-limited sign-in, archived session, and exhausted stream |
| Devices | One real iPhone with notch and home indicator (safe areas, keyboard, push tap); one Android phone or emulator (hardware back, keyboard) |

Automated coverage: pure helpers through Vitest; screen flows through
`pnpm test:e2e:remote-web` (E2E-266) on two mobile viewports, with screenshot
artifacts kept out of the repository; the existing native-config tests stay
green. Real-device acceptance remains with the operator, as in R6.

## 14. Decisions

Resolved on 2026-10-19; the owner delegated each choice to the recommended
option.

| ID | Question | Decision |
|---|---|---|
| O1 | Icons: add `lucide-react` to `apps/remote-web` or inline SVGs | Add `lucide-react` at the desktop's version; tree-shaken, no new vendor (phase 1) |
| O2 | Keyboard handling on iOS | Add `@capacitor/keyboard` with native resize (phase 3, with the composer); without it the dock can be hidden behind the keyboard |
| O3 | Markdown in assistant messages | Deferred to phase 4; a safe subset (paragraphs, lists, code, links) without HTML or remote images. Phases 1–3 render plain text with inline code |
| O4 | Confirmation for high-risk approvals | One confirmation sheet for `high` risk only; no press-and-hold gesture, for accessibility |
| O5 | zh-CN vocabulary 电脑 instead of 主机 | Adopted for user-facing copy; the protocol, code, and specs keep "Host" |
| O6 | Cross-computer "Needs you" section | Deferred to phase 4; polls the existing session list of each online computer on foreground only, no protocol change |

## 15. R7 revision — pages, model choice, attachments

- Status: **Proposed design, awaiting owner approval. Nothing in this section is
  implemented.** Where it contradicts §8, this section wins once approved.
- Why: the client grew past the scope §8 was written for. §8.6 still says a
  phone cannot start a session, §8.7 still describes answers as plain text, and
  three capabilities the owner asked for have no design at all: choosing a model
  when starting a session, sending images and files, and a per-session place to
  see and change model, mode, and permissions. §8.7's navigation bar and S5's
  grouping are already implemented as described (`SessionsScreen`,
  `SessionScreen`); the rest of §8 remains the visual and interaction
  reference.
- Scope of the change: presentation and interaction in `apps/remote-web`, plus
  two contract additions that a phone cannot invent for itself (a model catalog
  read, and the attachment upload the protocol already specifies but no Host
  implements). Nothing else in RACP changes.

### 15.1 Page inventory

Every screen answers one question and has exactly one primary action. A
screen's states are the ones its own data can be in; the empty state says what
to do next, never why the screen is useless.

| Screen | The question it answers | Content | Primary action | States | Empty |
|---|---|---|---|---|---|
| S1 Connect | "How do I start?" | Brand mark, one sentence of purpose, sign-in with a Minih account, pairing ticket | Sign in with Minih account (or Use a pairing ticket) | Account mode absent / present / refused origin | n/a |
| S2 Account sign-in | "Can this phone reach my computers?" | AccessKey field, device name, then the roster of computers that can approve, then the wait | Approve on the computer / Ask again | Key rejected, service unavailable, waiting, expired, granted-but-not-delivered, rate limited | No computer can approve → offers the pairing ticket |
| S3 Pairing ticket | "How do I connect one computer?" | Ticket field, device name, what happens next | Connect | Expired ticket, refused device, unreachable Gateway | n/a |
| S4 My computers | "Which computer do I work on?" | One row per computer: label, status line, unread attention | Open a computer | Online / offline / not synced yet / revoked / never paired | "No computers yet" → Connect a computer |
| S5 Sessions | "What ran, and what needs me?" | Search, project groups (or "Needs you"/"Running"/"Recent" when search is empty), one row per session, new-session entry | New session (when the device may create) or open the session that needs you | Loading skeletons, stale list dimmed with Retry, Host offline, revoked, no projects | "No sessions on this computer yet — start one here, or on the computer" |
| S5a New session | "With which model, in which project?" | Project choice, model choice, mode, permission mode | Start | No projects, no models, creating, refused (read-only device), project list failed | No project → Add a project; no model → the Host's default |
| S6 Session | "What is it doing, and what does it need?" | Navigation bar, connection banner, run bar, timeline (Markdown, tool cards, thinking), decision dock, composer | Decide (approve / answer) or send a message | Live, reconnecting, live updates stopped, disconnected, archived, replay incomplete, resync, truncated items | "No messages yet" |
| S6a Session info | "Which model and mode is this, and what is it called?" | Title (renameable), computer, model, thinking level, mode, permission mode, message count, created | Done | Read-only device (no edit affordances), turn running (model/mode locked), rename refused | n/a |
| S7 Push entry | "Why did this open?" | Opens S6 at the decision dock, S4 and S5 beneath | Decide | Already handled, unknown computer | Falls back to S4 |
| S8 Settings | "What does this phone remember, and how does it look?" | Account, computers and devices, notifications, appearance, build | (no single action; each row opens one) | Signed in / signed out, push not configured, permission refused, no device | "Nothing paired yet" → back to S1 |

Rationale for the two rules the table implies: a screen whose primary action is
missing must replace it with the reason and the next step (a read-only device
gets "This phone may only watch", not a disabled button), and a screen never
shows a control it cannot honour — the composer of an archived session is a
muted bar, not a disabled field.

### 15.2 S5a New session (issue: no model choice)

A sheet over S5 with four rows, in the order the decision is actually made:

1. **Project** — the Host's project catalog, archived projects hidden. With one
   usable project the row is pre-filled and reads as a value; with several it
   opens a list. "Add a project" stays at the bottom of that list (existing
   `project/browse` + `project/register`).
2. **Model** — the row shows the model that will be used and the provider's
   name ("Claude Sonnet 5 · Anthropic"). Tapping it opens the model list
   (§15.3). Until `model/list` has answered, the row says "Computer default" and
   the session is created without a model, which is what the Host would have
   chosen anyway.
3. **Mode** — `agent` / `plan` / `goal`, with one line each ("Works and edits",
   "Plans first", "Works until the goal or the budget").
4. **Permission mode** — `ask` / `accept-edits` / `auto`, with the same wording
   the desktop uses.

The primary button is "Start"; it creates the session with the four values, and
the client then opens S6 on that session with the composer focused. Creating is
`controller`; a `viewer`-only device never sees the sheet (S5 replaces the
entry with the reason, as today).

States: creating (button spinner, all rows disabled), refused (`FORBIDDEN`,
`NOT_FOUND` for a project deleted meanwhile, `INVALID_ARGUMENT` for a model that
disappeared between the list and the create) — each shown inline above the
button with the Host's own reason, and the sheet stays open so the choice can be
corrected.

### 15.3 Model list and model identity (contract addition)

Today `session/create` and `session/configure` accept `providerId`, `modelId`,
and `thinkingLevel`, but a phone has no way to learn which values exist, and
`RacpSession` carries no model at all — so neither a chooser nor a "which model
is this session on" label can be built on the client alone.

**`model/list`** (viewer role, `GET /v1/models` via the RACP-HTTP route table):

```ts
type ModelSummary = {
  providerId: string;
  providerLabel: string;   // display name only
  modelId: string;
  label: string;
  thinkingLevels: string[];  // ordered, as the provider advertises them
  defaultThinkingLevel?: string;
  supportsImages: boolean;   // what §15.4 gates on
  isDefault: boolean;        // the Host's default for a new session
};
// { models: ModelSummary[] }
```

Rules, in the order they constrain the design:

- **Metadata only.** The response carries no credential, API key, base URL,
  proxy, header, or price. The Host builds it from the same catalog it already
  uses to launch a turn, and drops anything it would not print on the desktop's
  model picker.
- **One read per visit, not per keystroke.** The list is small and static for
  the lifetime of a session; S5a reads it once when the sheet opens.
- **A model that is not listed cannot be chosen, but a listed model is not
  guaranteed** — a provider can be removed between the read and the create, so
  `session/create` keeps validating and the sheet shows the refusal.
- **Existing sessions.** `RacpSession` gains optional `providerId`, `modelId`,
  `modelLabel`, and `thinkingLevel`, so S6a can show what the session runs on.
  Optional and additive: a Host that does not send them still produces a valid
  session, and the client hides the row.
- **Changing a session's model** is `session/configure` with `providerId` +
  `modelId` (+ `thinkingLevel`), `controller` role, and **only while the session
  is idle**: the desktop already refuses to change the model under a running
  turn, and the phone must show the same reason (`AGENT_BUSY`) rather than
  appearing to succeed. A thinking level that the new model does not advertise
  resets to the model's default.
- **Both sides implement it.** The desktop Host (`desktop-host-operations.ts`)
  and `agent-host-cli` each get the catalog read, the shared contract and route
  table get the operation, and the Gateway needs no new code because it
  validates against those tables — but it does need a test proving
  `GET /v1/models` is forwarded like every other declared route.

### 15.4 Images and files (issue: cannot send them)

The protocol already defines the flow (§10) and nothing implements it: the Host
advertises `attachments: false`, both operations answer `CAPABILITY_UNAVAILABLE`,
and `turn/start` refuses an attachment. Two steps, smallest first.

**Step 1 — inline, bounded by what one request may carry.** A small image or a
small text file travels inside `turn/start`, which is the protocol's own first
case ("small text and image inputs MAY be embedded … below `maxPromptBytes`").

- Budget: the whole JSON-RPC request stays under `maxPromptBytes` (256 KiB) and
  therefore far under `maxFrameBytes` (1 MiB). One attachment at a time is
  therefore at most ~180 KiB encoded; the composer refuses a larger file with
  the size and the limit, and offers nothing fake.
- Accepted types, decided by **content sniffing on the Host**: PNG, JPEG, WebP,
  GIF images, and `text/plain`-family text (UTF-8, no NUL bytes). A declared
  MIME type that disagrees with the bytes is refused; an unknown type is
  refused. SVG is **not** accepted in step 1 (an SVG is a script container, and
  the client would have to render it).
- Where the bytes go: the Host decodes the attachment, writes it under its data
  directory in a session-scoped folder, and converts it to the
  `AgentPromptAttachment` the runtime already accepts, so the agent reads it
  from disk with no new runtime path.
- **Never a path or a URL.** The Host accepts no `file://`, no absolute path, no
  remote URL, and no "reference this file on my computer" form: an upload it did
  not receive is an upload it cannot vouch for (protocol §10 already forbids
  this; step 1 keeps the rule at the schema level).
- Cleanup: the folder belongs to the session and is removed with it; bytes that
  a failed turn never referenced are swept on the same schedule the Host already
  uses for scratch data.
- The Host advertises `attachments: true` and a
  `maxInlineAttachmentBytes` in capabilities, so a client never guesses the
  budget.

**Step 2 — larger files through the Gateway, chunked.** `attachment/create`
returns an opaque id plus a single-purpose, short-lived, principal- and
session-scoped upload target; `attachment/complete` carries size and SHA-256;
the Host verifies both and only then marks the attachment `ready`, and
`turn/start` references the ready id. Chunks cross the Host link at 256 KiB.
The Gateway holds bytes only until completion and verifies nothing but size.
Two bounds decide what "large" means here:

- Nginx serves this origin with `client_max_body_size 10m`, so a step-2 upload
  is capped at 10 MiB per file unless that limit is raised for the upload route
  alone — and a phone photo is usually smaller once the picker resizes it.
- The protocol's 50 MiB per-attachment ceiling stays a ceiling, not a promise.

**Client (both steps).** A paperclip button in the composer opens one sheet:
"Photo library", "Take photo", "Choose file". Chosen items appear as chips above
the field (image thumbnail or file-type tile, name, size, remove); each chip has
its own state — preparing, ready, too large (with the limit), failed (with
retry). Sending is allowed with chips still preparing (they are held) and
refused while any chip is failed. A thumbnail in the timeline row opens a
full-screen viewer with a close button; a file chip is not tappable, because the
phone has no way to open a Host file.

**Native permissions.** Picking needs no permission; taking a photo needs the
camera, and reading the library needs the photo library. Both usage strings are
added to `Info.plist` and the Android manifest equivalent, and the existing
native-config test learns about them. A refused permission is reported where the
sheet opened, with a link to the system settings — never as a silent no-op.

### 15.5 S6 additions

Baseline is §8.7. Three additions, all of them consequences of what the client
can now do:

- **Answers are Markdown** (already implemented, `#108`): fenced code in a
  monospace block that scrolls horizontally inside its own box, with a copy
  button; GFM tables inside a horizontally scrollable wrapper; inline code,
  links (http/https/mailto only), lists, quotes, headings. A partially streamed
  answer renders what has arrived, including an unterminated code fence — the
  reader is watching work in progress, not reading a document. No raw HTML, no
  remote images.
- **A truncated item says so** (implemented with the transcript window read): the
  Host caps one field at 64 Ki characters and marks the cut in the text itself;
  the row carries a "Shortened" chip and the copy button copies what is shown.
- **The composer names the model and the mode** it will send with: two small
  labels above the field ("Claude Sonnet 5 · agent"), tappable to open S6a. This
  is the only place a user is reminded that the phone is driving a real model,
  so it does not hide behind a menu.

### 15.6 S6a Session info sheet

A sheet, not a screen: the reader is looking at a conversation and wants one
fact or one change, then to be back.

- Header: the session title, with a rename affordance (pencil) for a
  `controller` device. Renaming is a field plus Done; a refused rename shows the
  Host's reason inline and keeps the typed text.
- Rows: computer (label), model (opens the same model list as S5a — `controller`
  only, and only while idle; a running turn shows the current model with the
  reason it cannot change), thinking level (the new model's levels), mode
  (agent/plan/goal), permission mode (ask/accept-edits/auto), messages, created,
  and the session id with a copy button for support.
- Foot: "Done".
- Every edit is a `session/configure` (or `session/rename`) round trip; nothing
  is applied optimistically, and the sheet keeps the previous value visible
  until the Host answers.

### 15.7 S8 Settings

The client's fourth tab, reachable from S4's trailing icon (not a tab bar — the
phone has three working surfaces and a tab bar would imply a fourth that does
nothing most of the time).

- **Account** — signed in with a Minih account, or not; "Sign out" revokes the
  account session only (§11.5) and leaves device tokens alone. No key or token
  is ever displayed.
- **Computers and devices** — one row per paired computer: label, last used,
  this-device marker, "Forget this computer" (which unregisters push first,
  existing `forget.ts`), and "Add a computer" → S1.
- **Notifications** — push registration state ("On", "Not allowed", "This
  Gateway has no push configured"), a button to open the system settings when
  permission was refused, and a note that the notification text never carries
  conversation content.
- **Appearance** — System / Light / Dark, applied immediately.
- **About** — build version, the Gateway origin, and the client version line
  already shown on S4.

Empty: nothing paired — one line and a button back to S1. States: every row that
calls the Host can fail, and fails in place with its reason.

### 15.8 Prototype

`apps/remote-web/design/prototype/index.html` gains: the new-session sheet with
a populated model list, the composer's model/mode labels and attachment chips,
a code block with a copy button and a table in a session, S6a, and S8. The
prototype stays a single file with simulated data, opened directly, and it is
the visual reference for implementation until the screens ship.

### 15.9 Implementation order and what it costs

| Step | Scope | Contract work | Exit |
|---|---|---|---|
| R7-1 | S5a + `model/list` + session model fields + S6a | shared schemas and route table, racp handler, both Host catalogs, Gateway forwarding test, ADR amendment | A session can be started on a chosen model, and its model can be read and changed while idle |
| R7-2 | Attachments step 1 (inline) + composer chips + timeline viewer | capability advertisement, `turn/start` attachment path, MIME and size validation, session-scoped storage and cleanup, iOS/Android usage strings | A photo or a small text file can be sent from the phone |
| R7-3 | S8 + S5 search + S6 Markdown copy button | none | Settings reachable; the list searchable |
| R7-4 | Attachments step 2 (chunked through the Gateway) | `attachment/create` + `attachment/complete`, upload route, Host link chunking | A file larger than a frame can be sent |

Each step is its own change, keeps the client buildable, and lands with tests at
the level of the risk: contract tests for the schemas and routes, Host tests for
the model catalog and the attachment validation (including a refused MIME, an
oversized payload, and a path masquerading as an attachment), client tests for
the choosers and chips, and `pnpm test:e2e:remote-web` for the two screens that
gain a real user path.

### 15.10 Decisions (resolved 2026-10-21)

The owner approved all three recommendations on 2026-10-21 and authorised
implementation. They are decisions now, not questions.

| ID | Question | Decision |
|---|---|---|
| R7-1 | Model chooser scope | The phone may both choose a model when starting a session **and** change an existing session's model, the latter only while the session is idle (`AGENT_BUSY` otherwise, the same rule the desktop applies) |
| R7-2 | Attachment scope | Step 1 only, for now: inline images and text under the request budget, no Gateway upload route, no chunking. Step 2 stays designed and unscheduled |
| R7-3 | Where settings live | A fourth screen (S8) behind S4's trailing icon, because notifications and appearance do not belong to one computer |

### 15.11 Tool calls read as actions, not output

The phone drew every tool call as its own bordered card: a 44 px row with the
state icon, the raw tool name in Mono, and one truncated line of the tool's own
output. A dozen consecutive calls became a dozen near-identical cards — the
widest, tallest, least informative content on a screen that only shows a handful
of rows at a time. The output is what a reader opens deliberately, not what a
row should be made of.

Rules, and they are the desktop transcript's rules rather than a second set:

- **One classification, one summary, one burst sentence.** They live in
  `packages/shared/src/tool-presentation.ts`, which the desktop transcript also
  imports (`toolIconCategory`, `getToolSummary`, `describeToolRun`,
  `groupConsecutiveToolRuns`). A call reads the same on both clients by
  construction, not by convention.
- **A row is a category icon, the tool's short name, one line of what it acted
  on, and its state.** No raw output. The category drives the icon (read, list,
  search, write, edit, command, web, subagent, plan), so a reader recognizes the
  kind of work before reading the words.
- **Consecutive calls fold into one row.** Collapsed it says what the burst did,
  one clause per kind of work, at most three clauses so the line cannot wrap
  ("4 commands, 2 files edited, 1 file written"), plus a failure count when any.
  Expanded it lists each call as a row above; expanding one of those shows that
  call's output. Two taps is the depth: "what happened here", then "show me that
  one".
- **A burst of one call is a plain row**, not a fold with one child.
- **All of it is localized.** The clause keys and the failure count are catalog
  entries in the nine shipped locales; no sentence is assembled from English
  fragments.

Acceptance: at 390×844, a twelve-call burst that occupied 14 rows and 827 px of
timeline occupies 3 rows and 161 px, with no horizontal page scroll, and the
expanded rows keep their per-call summaries. The before/after screenshot pair is
the evidence; the shared rules are covered by
`packages/shared/src/tool-presentation.test.ts` and the desktop's existing
`tool-display`, `tool-identity` and `tool-presentation` suites (unchanged, which
is what proves the extraction was behaviour-preserving).

## 17. Projects, status, and notifications (R7 follow-on)

- Status: **Proposed design, awaiting owner approval. Nothing in this section is
  implemented.** Where it contradicts §8 or §15, this section wins once approved.
- Why: the owner's request of 2026-10-21 was three complaints about one screen.
  The session list groups sessions under collapsible project headings, so choosing
  a session means reading four headings and eight rows; a row carries its state in
  a 12 px dot whose only difference between "running" and "needs your approval" is
  hue; and the phone cannot tell the user anything while they are not looking at
  it. This section replaces the grouping with two layers of navigation, gives every
  state one shape and one word, and designs the notifications the Gateway can
  already send but no operator has switched on.
- Scope: presentation and interaction in `apps/remote-web`, one additive field on
  an existing registration route, iOS native configuration, and operator steps.
  RACP keeps its operations and its redacted push payload; §15.3's `model/list`
  and the attachment flow are untouched.

### 17.1 What changes, and what it costs

| Today (evidence) | After |
|---|---|
| S5 lists one computer's sessions grouped under collapsible project headings (`SessionsScreen.tsx`, `session-groups.ts`) | S5 lists projects; a project opens its own session list (S5b) |
| A row's state is a 12 px dot plus a word in the subtitle; "waiting" and "running" differ by hue (`SessionRow.tsx`, `StatusDot.tsx`) | One vocabulary with two weights: an attention pill with an icon and a word, or a glyph plus a word (§17.4) |
| Nothing tells the user about a finished turn or a pending approval away from the app | Four notification kinds, a lock-screen body that names the session without that title ever transiting to Apple, in-app notices in the foreground, three settings switches (§17.6) |

Costs, stated up front: two pages and a rewritten nav stack (H5 only, ships with a
deploy); one additive registration field and a grouping key (Gateway);
entitlements, a Notification Service Extension, and a shared-keychain mirror of the
device token (iOS build); and the operator steps of §17.7. Nothing here needs a new
RACP operation.

### 17.2 Pages

Two pages replace the grouping on S5. Both answer one question, and both have one
primary action, following the rule §15.1 already states.

| ID | Page | The question it answers | Primary action |
|---|---|---|---|
| S5 | Projects of one computer | "Which project needs me?" | Open a project |
| S5b | Sessions of one project | "What happened in this project?" | Open a session, or start one |

S6 keeps its identity and gains nothing new here. S8 keeps §15.7 and gains the
notification rows of §17.6.5.

#### S5, projects of one computer

- Navigation bar: computer label, subtitle = computer state (the dot and word of
  §5.6). Trailing: refresh in browser builds, which have no pull to refresh. There
  is no large title: the bar already names the computer, so the page starts with a
  section header ("Projects", count) rather than a second heading saying the same
  thing.
- One card per project, stacked with 10 px between cards. A card is three lines:
  project label and session count; the aggregated state pills; the last-activity
  time, right aligned and muted.
- A project with nothing waiting shows a neutral line instead of pills ("No session
  needs you"), and the session count is always present, so a card is never just a
  name.
- A project with something waiting carries a 3 px `--rm-decision` rail on its left
  edge. The rail is a second cue and never the only one: the pill beside it says
  the same thing in words.
- **Aggregation is client-side.** `project/list` returns `{id, label, archived}`
  (`packages/shared/src/racp.ts:436`) and `session/list` returns the sessions with
  `projectId`, `status`, and `updatedAt`. Counting sessions per project, taking the
  newest `updatedAt`, and counting `running` and `waiting_permission` needs no new
  field and no second request, because the page already holds both lists. The one
  number it cannot compute is how many sessions wait for an *answer* (§17.4.1).
- **Order**: first by the four bands below, then by the newest session.
  1. projects with at least one session waiting for the user;
  2. projects with at least one session running;
  3. projects with sessions but nothing live;
  4. projects with no session at all.

  The fourth band falls out of the same comparison, because a project's recency is
  its newest session and it has none, so the rule stays one comparator rather than
  four cases. Ties break by label, so the order is stable across refreshes.
- **"Other"** — sessions with no `projectId`, or whose project left the catalog —
  is one trailing card labelled "Other", subtitle "Sessions without a project". It
  is a real destination (its S5b lists them) and it never sorts upward, so one
  stray session cannot push a real project down.
- **A project with no session is shown**, unlike §8.6's empty group, because it is
  now a destination with an action (start a session there) rather than a heading
  the user cannot act on. Archived projects stay hidden, as in §15.2.
- States: loading (three skeleton cards shaped like cards, not rows); read failure
  (error banner with Retry, the last cards kept at 60% while retrying, exactly
  §8.6's rule); project catalog unreadable (`session/list` alone still produces the
  cards, every session lands under "Other", and a neutral line says why); no
  sessions at all (empty state "Nothing has run on this computer yet", primary
  "Start a session"); revoked (§8.6's result state, unchanged).

#### S5b, sessions of one project

- Navigation bar: project label as title; subtitle = the computer and its state,
  because the project name alone leaves "which computer is this" unanswered after
  a push. Trailing: `+` for a new session (project pre-selected), and refresh in
  browser builds.
- Sections in this order, each hidden when empty: "Needs you" (an approval or an
  answer is pending), "Running", "Recent" (everything else, newest first). A
  section header carries the count.
- Row anatomy: leading 20 px status slot (§17.4); title up to two lines; subtitle =
  relative time, then the state word or attention pill, then the model label
  (`modelLabel`, when the Host sent one). The model label truncates first, because
  it is the least important fact on the line.
- The `+` opens §15.2's sheet with the project pre-filled and shown as a value
  rather than a chooser, because the user is standing in that project.
- Empty: an empty state naming the project ("web app has no sessions yet"), the
  sentence that work started on the computer appears here, and a dock primary
  "Start a session". This is where the layer earns its keep over a heading.

### 17.3 Navigation and back

The stack becomes four levels. `src/lib/screen-stack.ts` gains two screen kinds and
`previousScreen` stays the single rule, so the header back control, the Android
hardware back button, the browser's Back, and the iOS edge swipe still cannot
disagree (§4).

```text
S4 My computers  >  S5 Projects  >  S5b Sessions of one project  >  S6 Session
```

- **One project is not a list.** When the computer has exactly one usable project,
  tapping the computer pushes S5b directly and S5 is never in the stack, so back
  goes to S4. The skip is decided at the moment of navigation, from the same data
  S5 would render (`soleProjectForNewSession` in `session-groups.ts` already answers
  that question for the new-session sheet), so `previousScreen` never has to ask
  "was there a list above me".
- **One computer does not skip S4.** S4 owns connecting, forgetting, and settings,
  and it is where every failure that concerns the computer is explained. Instead,
  launching with exactly one *ready* computer opens that computer's S5 with
  `computers` already beneath it, so back still lands on S4 and nobody taps through
  a one-row screen on every launch. A computer that is offline, unaccepted, or
  revoked does not get this: the launch screen stays S4, because that is the screen
  that explains what is wrong.
- **A push restores the stack** (§8.8, extended). The payload names `hostId` and
  `sessionId`; the app finds the session's `projectId` in the list it reads anyway
  and writes `computers > projects > sessions` beneath S6. A back swipe from a
  pushed session therefore lands on that project's session list, not on the
  computer list. With one usable project the `projects` entry is omitted, exactly
  as a tap would have done. If the session is not in the list yet (created on the
  computer a moment ago) the `projectId` is unknown: the app opens S6 with
  `computers > projects` beneath and refreshes the list behind it, because a
  slightly shallower stack is better than a fabricated one.
- The edge swipe keeps §4's rules unchanged: a touch starting inside 20 px of the
  left edge and released past a third of the width pops one level through the same
  back path, and a mostly vertical drag is left to the list's own scroll.

### 17.4 One status vocabulary

Six states, three weights, one shape and one word each. The colours are the tokens
§5.1 already defines, which are the desktop's colours
(`apps/desktop/src/styles/tokens.css`: `--ds-warning` is `--rm-running`,
`--ds-purple` is `--rm-decision`, `--ds-success` and `--ds-error` match too).

| State | Derived from | Mark | Word | Motion |
|---|---|---|---|---|
| Needs your approval | `status === "waiting_permission"`, or `planningState === "awaiting_approval"` | shield (or plan) glyph in `--rm-decision` plus an attention pill | 等你批准 / Needs your approval | one 1.6 s pulse, twice |
| Needs your answer | not in the list today (§17.4.1) | question glyph in `--rm-decision` plus the same pill | 等你回答 / Needs your answer | the same pulse |
| Running | `status === "running"` | 8 px filled dot in `--rm-running` | 运行中 / Running | two 1.6 s breathing cycles, then steady |
| Failed | `status === "error"` | circled alert in `--rm-error` | 失败 / Failed | none |
| Finished, not looked at | `status` is `idle` or `aborted`, and `updatedAt` is newer than this device's `lastViewedAt` for the session | check inside a success ring (a shape difference, not an opacity difference) | 已完成 / Finished | none |
| Idle, or finished and looked at | `status` is `idle` or `aborted`, already viewed | a faint dot | no word | none |

The rules that hold in all three placements (a session row, a navigation subtitle,
a project card):

- **Never colour alone.** Every state pairs its hue with a glyph and a word: the
  pill carries the word, and a settled state puts the word in the row subtitle. A
  monochrome screenshot still reads.
- **Attention is the only filled mark.** "Needs you" is the one state with a tinted
  background; running and settled states stay flat, which is what makes the
  exception mean something (§3, decisions first).
- **A project card shows two facts**: how many sessions need the user (attention
  pill with a count) and how many are running (running pill with a count). A sixth
  count on a card would read as noise, and the settled ones are one tap away.
- Motion follows §5.5: the pulse and the breathing run two cycles and stop,
  `prefers-reduced-motion` renders the steady mark, and no status animates for as
  long as work lasts — that is reserved for S6's run bar.
- Accessibility: the pill's word is the accessible name, a row's `aria-label` reads
  "title, state, time" so a screen reader hears the state without the glyph, and a
  change on the visible screen is announced through the polite live region §9
  defines.

#### 17.4.1 The one state the data cannot express

`RacpSession.status` is a closed union of `idle`, `running`,
`waiting_permission`, `aborted`, and `error` (`packages/shared/src/racp.ts:55`). A
tool approval sets `waiting_permission` (`packages/agent-host/src/agent-host.ts:350`),
while an input request sets only the *turn's* status to `waiting_input` and leaves
the session at `running` (`agent-host.ts:361`), so a session waiting for an answer
is indistinguishable from a busy one in `session/list`. The design therefore does
two things and says which one is temporary:

1. **Now**: an `input.requested` push marks that session as "Needs your answer" in
   a device-local map, cleared when the session is opened or answered. Accurate
   whenever a notification was delivered, and honest about its limit: a user with
   notifications off sees "Running".
2. **Follow-up** (needs a desktop release and a contract addition): add
   `waiting_input` to `RacpSessionStatus`, or a `pendingInput` count beside
   `queuedTurnIds`. The Host already knows the answer (`agent-host.ts:671` derives
   `waiting-input` for its work snapshot), so this is a contract change rather than
   new logic. Not scheduled here.

"Finished, not looked at" needs no protocol change: it is a device-local
`lastViewedAt` per session, written when S6 opens and stored beside the registry
entry. Its limit belongs in the design: it is per phone, and a reinstall makes
every session "looked at".

### 17.5 Empty, loading, and failure

| Page | Loading | Empty | Failure | Offline |
|---|---|---|---|---|
| S5 | three skeleton cards | "Nothing has run on this computer yet" and Start a session | error banner with Retry, cards kept dimmed | §8.5 / §8.6 rules, unchanged |
| S5b | six skeleton rows | names the project and offers Start a session | error banner with Retry | last list kept at 60%, as §8.6 |

Neither page renders a heading with nothing under it, and neither shows a control
it cannot honour (§15.1's two rules).

### 17.6 Notifications

The chain exists end to end and is switched off. In order: the desktop Host reports
the four kinds on `host.notify` (`apps/desktop/electron/main/bootstrap/startup.ts`);
the Gateway checks audience, dedupes, budgets, and calls APNs or FCM
(`apps/remote-gateway/src/push.ts`); the payload is a closed object of a kind, two
localization keys, and ids (`RacpPushPayloadSchema`,
`packages/shared/src/racp-hostlink.ts:747`); the client registers a token per
credential (`apps/remote-web/src/hooks/usePushRegistration.ts`) and resolves a tap
to a screen from the ids alone (`apps/remote-web/src/lib/push.ts`). What keeps it
dark is a missing flag set on the Gateway and a missing entitlement in the iOS
build (§17.7).

#### 17.6.1 Kinds and copy

The eight keys stay `push.notify.<kind>.title` / `.body` (`pushKeysForKind`,
`racp-hostlink.ts:768`), because they are also generated into the app bundle's
`Localizable.strings` and `strings.xml` and the *system* renders them while the app
is closed. Only their values change. zh-CN and en are normative; the other seven
locales translate from en.

| Key | Today (zh-CN) | Proposed zh-CN | Proposed en |
|---|---|---|---|
| `push.notify.approval.requested.title` | 需要你处理 | 等你批准 | Needs your approval |
| `push.notify.approval.requested.body` | 有会话在等待你批准一项操作。 | 有会话在等你批准一项操作。 | A session is waiting for your approval. |
| `push.notify.input.requested.title` | 需要你处理 | 等你回答 | Needs your answer |
| `push.notify.input.requested.body` | 有会话在等待你的回答。 | 有会话在等你回答一个问题。 | A session is waiting for your answer. |
| `push.notify.turn.completed.title` | 回合已完成 | 已完成 | Finished |
| `push.notify.turn.completed.body` | 有会话的回合已完成。 | 有会话运行完成了。 | A session finished running. |
| `push.notify.turn.failed.title` | 回合失败 | 运行失败 | Run failed |
| `push.notify.turn.failed.body` | 有会话的回合失败了。 | 有会话运行失败了。 | A session's run failed. |

The move from 回合 to 运行 is §10's own rule: no protocol vocabulary in
user-facing copy. Both titles and bodies stay kind-level, so the two requests read
differently from the two outcomes without naming anything.

#### 17.6.2 The body names the session, and the title never leaves the phone

The owner decided on 2026-10-21: show the session title, and keep it away from
Apple. The mechanism is iOS's Notification Service Extension, and it is cheap here
for one reason worth recording: the Gateway already sends `aps.mutable-content: 1`
(`apps/remote-gateway/src/push-providers.ts:162`), so the extension is invoked as
soon as it exists and no Gateway change is needed to trigger it.

```text
Host --host.notify{kind, sessionId}--> Gateway --redacted aps--> APNs --> phone
                                                                           |
                     Service Extension: GET {origin}/v1/sessions/{sessionId}
                     +-- 200 -> body := the session title
                     +-- timeout / 401 / 404 / no credential -> body stays
                                                              the fixed key
                                                                           |
                                                                     lock screen
```

- **What APNs carries is unchanged**: `title-loc-key` = the kind label, `loc-key` =
  the fixed body key, plus the ids (`sessionId`, `hostId`, `approvalId`). Apple
  transports no sentence and no title.
- **Which request the extension makes**: `GET /v1/sessions/{sessionId}`, the
  existing `session/get` — `viewer` role, one record, no transcript
  (`packages/shared/src/racp.ts:604` and `:716`). It answers
  `{ session: { title, ... } }` (`packages/racp/src/operations.ts:288`); the
  extension reads `title` and discards the rest without persisting it. `viewer` is
  enough, so a read-only phone still gets a titled notification.
- **Authentication**: the device token for `hostId`, read from a shared Keychain
  access group, sent as the native profile's `Authorization: Bearer ...`. The
  Gateway origin comes from the same shared store, because the extension cannot
  read the app's baked-in build constant.
- **The time budget.** The system gives a service extension about 30 s and then
  calls `serviceExtensionTimeWillExpire`. The extension imposes its own shorter
  deadline — 8 s (a 5 s request timeout plus margin) — and delivers either way: on
  timeout, `401`, `403`, `404`, or an unreadable credential it calls the content
  handler with the unmodified content, so the user sees the fixed sentence.
  `serviceExtensionTimeWillExpire` must also call the handler with whatever it has,
  because a handler that is never called is a notification that never appears.
- **Keychain sharing, and the migration it needs.** Today's token lives in
  `@aparajita/capacitor-secure-storage` (`apps/remote-web/src/lib/native-secure-store.ts`),
  which is KeychainSwift behind Capacitor with no keychain access group — the
  plugin's source never sets `kSecAttrAccessGroup`, so its items live in the app's
  private group where a second process cannot read them. The migration is explicit
  and small:
  1. both targets list `keychain-access-groups` =
     `$(AppIdentifierPrefix)group.app.minih.remote`, and both carry the App Group
     `group.app.minih.remote`;
  2. the app mirrors, per paired Host, one generic-password item
     `{ origin, hostId, token }` into that group with
     `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, the protection class the
     app already uses;
  3. the mirror is written on pair, on account adoption, and on `ready()`, and
     deleted on forget and on sign-out; the app's own store stays the source of
     truth, and a failed mirror write only costs the title, never the app.

  This is the one place where the extension constrains the client, so it is its own
  step (§17.9, P3) with its own test: a forgotten Host loses its mirrored item, and
  a signed-out account device loses it too.
- **A switch the extension honours.** "Show the session title" is a flag in the App
  Group's `UserDefaults`. Off, the extension never makes the request. Off is a
  privacy answer rather than a degraded mode, so the row explains it in one line.
- **The privacy boundary is unchanged in kind.** The title travels between this
  phone and the user's own Gateway, over TLS, on a request the phone authenticates
  as itself. It never enters the push payload, an APNs or FCM message, a Gateway
  log, or an audit record. ADR 0331 decision 7's redaction rule is therefore
  intact, and the only thing that is new is *where the client gets the words*.
- **Grouping.** `thread-id` on iOS = the session id, so several events about one
  session stack into one group; FCM's `tag` = the same id on Android. Both are
  derived from `sessionId`, which the payload already carries, so the closed
  payload schema does not change — this is a change in `push-providers.ts` only
  (§17.9, P2).
- **Badge.** No `aps.badge`, deliberately: a correct badge is a count of what is
  waiting for *this user*, and neither the Gateway nor the Host knows what the user
  has already seen, so a number the Gateway invented would be wrong within minutes.
  The app sets `UNUserNotificationCenter.setBadgeCount` from the aggregate it
  already computes (P3) and clears it when it opens. The limit is stated: while the
  app is closed the badge does not move. A server-computed badge needs a
  pending-attention count in `host.notify`, which is a protocol change and is not
  proposed here.

#### 17.6.3 A tap

`destinationForTap` already resolves the ids to a screen; §17.3 supplies the stack
to restore. Two additions: an `approvalId`, when present, opens S6 scrolled to the
decision dock (§8.7); and a notification whose approval was handled elsewhere shows
"Already handled" with the outcome in the timeline, which §8.8 already specifies.

#### 17.6.4 Foreground: an in-app notice, not a system banner

When the app is open, a notification must not cover the screen the user is working
in. The iOS plugin's `willPresent` already returns no presentation options when the
build configures none — `@capacitor/push-notifications` returns an empty set and
still notifies JS — so nothing is shown by the system today, and what is missing is
the JS listener. Therefore:

- the app subscribes to `pushNotificationReceived` and renders a notice bar
  directly under the navigation bar: state glyph, the kind as its title, the session
  title as its line, "查看" and a dismiss button. It is `role="status"` with
  `aria-live="polite"`, so a screen reader reads it once;
- an attention notice (approval or answer) stays until the user opens or dismisses
  it, because it is the reason the phone spoke; completed and failed notices leave
  after 6 s;
- "查看" pushes S6 with the same restored stack a tap builds, so the two paths
  cannot diverge;
- no sound, no vibration, and no card over the decision dock: the user is already
  there.

#### 17.6.5 Settings switches, and where they live

| Switch | Enforced by | Cost |
|---|---|---|
| Notifications on or off (master) | the OS: asked once, and "no" is final for that launch; the row shows the state ("On", "Not allowed", "This Gateway has no push configured") and opens system settings when refused | none |
| Only notify me about things that need me | the **Gateway**, because the OS delivers a notification the app cannot recall; one optional field on the existing registration route | P2 |
| Show the session title | the **app**, read by the extension from the App Group | P3 |

Reusing the registration route, as asked: `PUT /v1/push/registration` gains one
optional field, `onlyActionable?: boolean`, stored on
`GatewayPushRegistrationRecord`, and `PushService`'s kind gate drops
`turn.completed` and `turn.failed` for a registration that set it. The route, the
method, the audience rule of §11.5, and the dedupe are untouched; a client that
does not send the field keeps today's behaviour exactly. The request schema has no
closed-object boundary of its own, so an older Gateway would tolerate the field and
ignore it — which the user would experience as a switch that does nothing. The app
therefore shows the switch only when the registration answer echoes it, and
`RacpPushRegistrationResponseSchema` gains
`preferences?: { onlyActionable: boolean }` for exactly that.

Default for the first release: the filter is **off**, so all four kinds are sent,
because "your work finished" is the notification people want until it proves
noisy. Turning the filter on is one tap.

#### 17.6.6 Android and the browser

- **Android** gets the same redacted payload, the four kinds, per-session grouping
  through `tag`, a tap destination, and the in-app notice (the same JS listener).
  It does **not** get the session title in this round: the equivalent of a service
  extension there is a data-only FCM message plus an `onMessageReceived` path that
  has to work while the app is dead, which is a background service and a revivable
  process — a much larger change than one extension. The fixed sentence is what
  Android shows, and the title switch is hidden on that platform rather than shown
  as a lie.
- **The browser build** gets nothing, and is recommended to keep getting nothing.
  Web Push needs a VAPID key pair (another operator secret), a service worker, and a
  second credential story — the cookie profile's `SameSite=Strict` cookie is not
  sent by a push subscription's background fetch — and on iOS it only works after
  the site is added to the Home Screen, which is a different product than "open the
  URL". ADR 0331 decision 7 scopes push to the app; this section does not widen it.

### 17.7 Operator checklist

The Apple account is a paid Apple Developer Program membership (team
`CQ8XQD6L2J`), confirmed by the owner on 2026-10-21, so an APNs Auth Key can be
created. In order, once:

1. **Create the APNs Auth Key.** Apple Developer → Certificates, Identifiers &
   Profiles → Keys → **+**. Name it (for example `Minih Remote APNs`), tick *Apple
   Push Notifications service (APNs)*, Continue, Register. Download the `.p8` once
   — Apple will not let you download it again — and write down the **Key ID**
   shown beside it (10 characters).
2. **Note the other two values**: Team ID `CQ8XQD6L2J`, and the bundle id
   notifications belong to, `app.minih.remote` (from `capacitor.config.ts` and
   `PRODUCT_BUNDLE_IDENTIFIER`). That bundle id is `--apns-topic`; a wrong topic
   rejects every token with `DeviceTokenNotForTopic`.
3. **Sign the build.** The Push Notifications capability is already committed
   (`apps/remote-web/ios/App/App/App.entitlements`, wired into both
   configurations), so `open apps/remote-web/ios/App/App.xcodeproj`, select the
   `App` target, and choose your own Team under Signing & Capabilities;
   automatic signing enables the capability for the App ID on the first build.
   *App Groups* and *Keychain Sharing* with `group.app.minih.remote` are added
   with the extension of §17.6.2, because nothing before it needs them.
4. **Add the Notification Service Extension** (§17.9, P3): bundle id
   `app.minih.remote.notificationservice`, embedded in the app, carrying the same
   App Group and keychain access group.
5. **Put the `.p8` on the Gateway.** Never paste it into a chat, an issue, or the
   repository; copy the file itself and then fix its owner and mode:

```sh
# from the machine that downloaded it
scp AuthKey_ABCDE12345.p8 <user>@<host>:/tmp/apns.p8
# on the server
sudo install -o minih-gateway -g minih-gateway -m 600 /tmp/apns.p8 \
  /etc/minih-remote-gateway/apns.p8
rm -f /tmp/apns.p8
```

   `0600` and ownership by the service user are not optional: the Gateway refuses a
   key file anyone else can read (`apps/remote-gateway/README.md`, "Redacted push").
6. **Start the Gateway with all four APNs flags** — all four or none, or it refuses
   to start (`apps/remote-gateway/src/push-config.ts:143`):

```sh
remote-gateway serve ... \
  --apns-key-file /etc/minih-remote-gateway/apns.p8 \
  --apns-key-id  ABCDE12345 \
  --apns-team-id CQ8XQD6L2J \
  --apns-topic   app.minih.remote
```

7. **Check it from the phone, not the server.** Install the build, open it once
   (that is when it registers), confirm the registration answers `enabled: true`
   with a non-empty `hostIds`, then finish a turn on the computer with the app
   backgrounded. A lock screen naming the session means steps 1–6 are all right;
   the fixed sentence with no title means the extension or the keychain mirror is
   at fault, not APNs.

For Android when that build matters: `google-services.json` from the Firebase
project into `android/app/`, the Google Services Gradle plugin, and the FCM
service-account JSON as `--fcm-service-account-file` under the same `0600` rule.

### 17.8 Prototype and evidence

`apps/remote-web/design/prototype/projects-notifications.html`, a sibling of
`index.html` (which keeps S1–S8): one file, simulated data, the client's own
`--rm-*` tokens, light and dark. It demonstrates S4 → S5 → S5b → S6 and back; the
six states in all three placements; a project with nothing waiting; a project with
no session; "Other"; the new-session sheet with the project pre-filled; a lock
screen with the enriched title, with a same-session group, and with the fixed
fallback; a tap that lands on S6 with the stack restored; and the foreground
in-app notice.

How it was checked, so the reader can weigh the claim: real Chromium at 390×844
through `playwright-cli`; every state reached by clicking a rendered element, with
a missing target failing the run; one screenshot per state; and these assertions —
`document.documentElement.scrollWidth === 390` on every screen, no horizontal
overflow inside the scroll content, no element crossing the phone's left or right
edge, no interactive element under 44 px other than the composer's 36 px send
button that §8.7 already specifies, and no console error. The navigation stack was
read back after every step, which is what proves a push tap restores
`computers > projects > sessions` and that one back step from it lands on that
project's session list.

### 17.9 Implementation order

Four steps, each buildable and shippable on its own, in dependency order.

| Step | Scope | What ships with it | Exit |
|---|---|---|---|
| **P1** | S5 projects, S5b sessions, the status vocabulary, the nav stack and push restore, the local `lastViewedAt`, the foreground notice, the S8 notification rows that need no new data | `apps/remote-web` only: a web deploy and a new app build; no Gateway, no protocol change | choosing a session costs one tap fewer, every state is legible in monochrome, and a push opens the right place |
| **P2** | `onlyActionable` on the registration route (field, record, echo, kind gate), `thread-id` and `tag` grouping, the eight copy values | shared schema, Gateway store, `push.ts` gate, `push-providers.ts`; a Gateway deploy, no desktop release | "only things that need me" is enforceable, and one session's events group |
| **P3** | iOS: entitlements (push now; App Group and keychain sharing with the extension), the Notification Service Extension with its 8 s deadline and fallback, the shared-keychain mirror and its cleanup, the badge, the title switch | Xcode project and extension target; `native-config.test.ts` changed from "no entitlements file" to "only the declared keys, no team id, no `.p8`, no token" (the push key alone is already committed); the mirror code in `apps/remote-web` | a lock screen names the session, and a forgotten Host loses its credential copy |
| **P4** | follow-ups, not scheduled: `waiting_input` (or a pending count) in `session/list`; Android title enrichment; a server-computed badge | a protocol and desktop change, or a new Android background path | each accepted on its own |

P1 is the whole of the owner's first two complaints and needs nothing from anyone
else. P3 is the notification design, gated on the Apple steps of §17.7, which are
the owner's rather than the code's.

### 17.10 Acceptance

| Dimension | Cases |
|---|---|
| Navigation | S4→S5→S5b→S6 and back at 320×568 and 390×844; the one-project skip; the one-computer launch; a push tap that restores the stack; a session missing from the list |
| States | every row of §17.4 in a session row, a navigation subtitle, and a project card, in light, dark, and monochrome (a grayscale screenshot must still read) |
| Sorting | waiting before running before recent before empty; "Other" never sorts up; the order is stable across two refreshes |
| Empty and failure | no sessions, a project with no session, "Other" alone, an unreadable project catalog, revoked, offline |
| Notifications | four kinds on a lock screen, grouped and ungrouped; the fixed fallback; a tap to S6 at the decision dock; the in-app notice for an attention kind (persistent) and an outcome kind (6 s) |
| Settings | the master switch states; "only things that need me" hidden when the Gateway does not echo it; the title switch off yields the fixed copy |
| Text size and locales | 100% and 200% with no horizontal page scroll; zh-CN, en, and de (longest strings) with no clipped title, pill, or count |

Automated coverage: the new pure helpers (aggregation, sectioning) get Vitest
tests beside them; the two pages and the foreground notice go through
`pnpm test:e2e:remote-web` (E2E-266) at two mobile viewports with screenshot
artifacts kept out of the repository; the Gateway field and the kind gate get route
and unit tests; the extension's deadline and fallback path is unit-tested against
an injected transport, and real-device acceptance of the whole chain stays with the
operator, as in R6.

### 17.11 Open questions for the owner

Each is designed above with a recommendation; none blocks P1.

| ID | Question | Recommendation |
|---|---|---|
| N1 | With one ready computer, land on that computer's projects or on the computer list? | Land on the projects with the computer list beneath (§17.3): one tap fewer, and back still reaches the computer screen |
| N2 | "Needs your answer" now (from a push, incomplete without notifications) or after the contract gains `waiting_input`? | Now, and schedule the contract follow-up; the alternative shows nothing until a desktop release |
| N3 | The project page as cards or as one grouped list? | Cards: the aggregate pills need the width, and a card reads as a destination rather than a row |
| N4 | Does the first release notify on finished runs as well as pending decisions? | Yes, all four kinds, with the filter one tap away (§17.6.5) |
