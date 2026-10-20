# 13. Remote Mobile Client UX

- Status: **Accepted design, not implemented** — decisions O1–O6 resolved on
  2026-10-19 (section 14); the shipped `apps/remote-web` UI does not follow it
  yet. The clickable prototype `apps/remote-web/design/prototype/index.html`
  (open the file directly; data is simulated) was reviewed at 320×568 through
  430×932 and is the visual reference for implementation.
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

Back behavior: the header back control and the Android hardware back button
pop one level (existing `previousScreen`); iOS additionally supports the edge
swipe through the standard history gesture in the WebView only when it does
not conflict with horizontal scrolling inside code blocks.

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
  such as the computer name on S6.

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
- Grouped by section, each omitted when empty: "Needs you" (status
  `waiting_permission`), "Running" (`running`), "Recent" (everything else),
  newest first within each section.
- Row: leading 12 px status slot (section 5.6), title up to two lines (session
  title, falling back to "Untitled session" rather than the raw id), subtitle
  "3 min ago" plus the state word for non-idle states ("Stopped", "Failed").
  Relative time uses `Intl.RelativeTimeFormat`; older than 7 days shows a date.
- Loading: six skeleton rows. Refresh: pull to refresh and on foreground.
- Empty: EmptyState "No sessions on this computer yet", Callout "Start a task
  on the computer and it will show up here. Sessions can't be created from the
  phone."
- Offline or failed load: error Banner with "Retry"; the last loaded list stays
  visible but dimmed to 60%.
- Revoked: ResultState "This phone's access was revoked" with primary "Forget
  and pair again".

### 8.7 S6 Session

**Navigation bar.** Back, title = session title, subtitle = computer label.

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
- Assistant message: left aligned, no bubble, full width, Body text with
  preserved line breaks; links use `--rm-link`. A small caption "From
  {agent}" precedes messages attributed to a sub-agent.
- Thinking: collapsed disclosure "Thinking" (Footnote, muted, chevron).
- Tool call: compact row in an inset container — state icon (spinner, check,
  or alert), tool name in Mono, one-line summary, chevron. Expanding reveals
  the detail in Mono 13 inside `--rm-bg-inset`, horizontally scrollable, capped
  at 320 px with "Show all".
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
