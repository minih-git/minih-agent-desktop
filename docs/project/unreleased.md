# Unreleased changes

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
