# Unreleased changes
- Each assistant turn summarizes its changed files; selecting a file opens the
  existing Review panel focused on that change.
- Conversations recover safely from malformed tool calls, real DeepSeek reasoning
  remains compatible with relays, and exhausted billing quotas stop retrying.
- Oversized screenshots use safe model-input fallbacks. Tool images are stored
  losslessly without repeated payloads, and normal history edits use message IDs
  instead of uploading the complete conversation. The upgraded profile requires
  the new application; rollback needs a complete pre-upgrade backup.
- Reopened windows restore live task state; returning to latest preserves follow
  intent, empty-draft steering can send queued follow-ups, and provider operations
  keep independent per-row busy guards.
- Official DeepSeek endpoints receive the selected thinking effort by default;
  relay defaults and explicit per-model send/omit settings remain intact.
- Restored conversation reading continues automatically without narrowing cached
  pages or moving the viewport. Automatic folding respects temporary focus and
  selection without pinning ancestor choices; Minih density modes remain intact.
- The Todo/background-task dock starts collapsed and keeps its expansion across
  sessions. Saved custom API keys have an accessible clear icon beside the input;
  removal remains staged until Save.
- Isolated-session file references open the branch copy instead of the parent
  checkout. Revisiting a conversation restores an unpinned reading bookmark
  even when the follow flag is stale. Large local projects can find deep files
  with `@` beyond the initial 8000-entry snapshot, while Minih `#` conversation
  completion stays unchanged.
- MCP OAuth explains when a server has neither a usable registered client nor
  dynamic client registration, instead of opening an invalid authorization
  page. Background-command row leads now toggle output with click or native
  Enter/Space; Output, Stop and Dismiss remain independent. These are selected
  upstream adaptations, not a dependency upgrade or a transcript display-mode
  replacement.
- The phone's conversation screen now matches your desktop. Tool calls are
  listed by name together with whether they are still running, finished,
  failed, or were denied, and with what they were asked to do, instead of
  appearing as empty boxes, and a message that arrived while the app was
  catching up no longer disappears. A long conversation opens at its newest
  message with the message box on screen — it used to open at the very
  beginning, with the box below the fold — **Load earlier** brings in older
  messages without moving what you are reading, and messages that arrive while
  you are reading further up are announced by a button that says how many you
  have missed and takes you back to them.
- A Host started with `agent-host-cli` only registers projects inside
  `--browse-root` (your home directory by default), the same limit the folder
  picker always had. Registering a folder elsewhere needs a `--browse-root` that
  contains it.
- A phone can now start work on your computer, not just steer it. Opening the
  new-session picker offers **Add a project**: it walks your folders from your
  home directory down, and picking one registers it and opens a conversation
  there, so a folder no longer has to be set up on the desktop first. The
  folders it may reach are the ones under your home directory; a path that tries
  to leave it is refused. Your computer shows a notice naming the device that
  started the conversation or added the folder. This needs the new desktop
  version: the desktop is what serves these operations to the phone.
- The phone shows conversations by project and can start a new one. The session
  list is grouped under the project names your computer reports, in the same
  order the desktop sidebar uses, and a conversation that belongs to no project
  (or to one that no longer exists) stays under "Other" instead of disappearing.
  Groups collapse. When the project list cannot be read the conversations stay
  in one list with a note saying why. A device that may control this computer
  gets a **New session** button: it goes straight to your only project, or asks
  which one, and the new conversation opens ready for the first message. A
  read-only device sees the reason instead of the button.
- Computers registered for remote access now report their own name, so the phone
  lists "Studio-Mac" instead of `host_11c73275-…`. A computer that was registered
  before this build keeps the id it registered with.

- Switching a long conversation to another model no longer sends the new model
  the whole history on every request. On the first message after the switch, a
  large conversation is summarized once by the new model while the most recent
  exchanges stay word for word, and a short notice says the context was
  compacted for the selected model. Short conversations are sent as they are,
  trying a model and switching back before sending costs nothing, and if the
  summary cannot be made the message is simply sent with the full history. This
  compaction does not rename the conversation.
- The iPhone and Android apps can load the session list again. Their webview
  runs from a cross-origin origin, so the browser preflighted every request and
  dropped it because the Gateway did not allow the `x-minih-racp-client` header
  the RACP client sends — the host looked online but any screen behind it failed
  with "Load failed". The Gateway now allows exactly the headers the client
  sends, taken from one shared list, and exposes `x-trace-id` so an error in the
  app still carries the trace id.
- Remote access now works right after launch. The virtual LAN channel used to
  start without asking your Minih Router for its configuration, so account mode
  stayed "unavailable" — with no reason shown — until you touched a setting or
  reconnected the channel, even though the channel itself was connected. It now
  asks at every start, and in No-TUN mode it asks through the local forward that
  can actually reach the Router; when that answer only arrives after the channel
  is up, the channel is restarted once so it applies. An unavailable account mode
  always says why.
- Remote access moved onto the Accounts page, right below your Minih Router
  account and its virtual LAN channel, and the separate Remote gateway entry
  left the settings list. Everything account mode needs stays visible — whether
  the Router can register this desktop, the switch that does it, the link state,
  the per-terminal confirmation switch, and the paired devices. A gateway you
  run yourself, with its address, CA certificate, and registration code, is now
  a collapsed **Advanced: self-hosted gateway** area that opens by itself if you
  registered that way. Searching settings for "gateway", "registration code", or
  "pairing" lands on the same place.
- Remote access works on a desktop that has just installed Minih Router. In
  0.22.0 the Remote gateway page only learned whether account mode was usable
  once the link started, and the link only starts with the remote-access switch
  — which the page greyed out until the desktop was registered. A fresh install
  therefore showed no account-mode section and an unusable switch, leaving only
  the old registration-code form. The page now checks whether your Router
  account can register this desktop without registering anything, and the
  switch is offered when either an enrollment exists or that check passes.
  Turning it on is still what registers the desktop, so nothing runs and
  nothing listens while the switch is off.
- Learned memory syncs with the opt-in Memory category of Cloud sync: the notes
  you kept, in both scopes, and the deletes that keep a forgotten note from
  coming back travel between your devices, while suggestions and the counters
  below stay where they were made. Notes merge one by one, so two devices that
  each wrote something keep both instead of asking you to choose between two
  sets of notes, and a note written on both becomes one. Every device of a vault
  must run this build or newer: a build that does not know the new domain
  refuses to read a revision that carries it, so it stops syncing until it is
  updated.
- The memory manager shows how the feature is doing on this device: the size of
  the index the last session started with, how many suggestions you kept or
  discarded and at what rate, how often a delete blocked a write, and today's
  extraction spend. None of it is uploaded, and none of it syncs.
- The learned-memory settings live on the AI tab of Settings and nowhere else:
  the card used to render on every destination, so the same switches appeared
  again on General, Shortcuts, and the rest. The automatic-learning row also
  stopped claiming a model was missing while one was already chosen, and
  settings search now finds the learned-memory rows under AI.
- Merging folders into a project group now checks the combined pinned memory
  against the 32 KiB limit before writing anything. A merge that would pass it
  is refused with a clear message instead of storing an oversized group: the
  group, its memory, and every folder's own memory stay exactly as they were,
  and no user text is truncated or dropped. Shorten the memories that are
  joining and try again.
- An on-demand tool lookup (`ToolSearch`) no longer reads as a file search. It
  used to list the tool name once per result field — `matches`, `activated`, and
  an internal bookkeeping list — each rendered as a clickable file, so clicking
  the tool's own name reported that no such file exists. The row now names the
  tools it activated, or the ones that were already available, or says that
  nothing matched, and a tool name is never a link. A lookup that failed keeps
  its failed row and does not claim that nothing matched. A plugin or MCP
  result's plain string list behaves the same way: only entries that look like
  file paths open, the rest stay text.

- Main sessions and subagents can retry a failed response after context
  compaction has already removed the failed assistant message. Explicit empty
  quoted prompt-template arguments keep their positional slots.
- Activating an overflowing work-panel tab keeps its close action visible.
- Provider model-list and connection probes can recover from optional client
  certificate requests without weakening server certificate verification.
- On macOS, Appearance offers a translucent-window switch. Glass stays on by
  default; turning it off uses an opaque native surface after relaunch.
