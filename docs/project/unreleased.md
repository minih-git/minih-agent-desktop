# Unreleased changes

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
