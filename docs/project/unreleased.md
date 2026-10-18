# Unreleased changes

- Cloud backup retains account display labels and explicit provider reasoning
  settings alongside saved model bindings and defaults. API tokens remain an
  encrypted, explicitly selected credential category; OAuth sessions stay local.
- A bottom-left account menu shows Minih Router balance, quotas and usage with
  refresh, account management, Settings and Cloud sync actions. Scheduled tasks,
  Plugins and Activity now use labeled sidebar navigation rows.
- The agent can search its earlier conversations in the current project and the
  notes learned from them, and a new session starts with a short index of those
  notes. Reading learned memory is on by default; it follows the portable
  `learnedMemory.read` setting and can be turned off without deleting anything.
- The agent can keep a durable note when the user asks it to, with a receipt in
  the conversation that offers Edit and Undo. A memory manager in the project
  row menu and in Settings lists, filters, edits, archives, restores, and
  deletes those notes, and Settings gains the reading switch plus a per-session
  "don't learn from this conversation" in the session menu.
