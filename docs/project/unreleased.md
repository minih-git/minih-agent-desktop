# Unreleased changes

- Remote control can join your Minih Router account. When the Router offers
  it, turning on remote control enrolls this computer with the saved Router key
  instead of a registration code; a phone or browser signs in at the Gateway with
  the same key, asks for a device, and one approval on any of the account's
  computers gives it one device that works on all of them. The key stays in the
  desktop's main process and is dropped by the phone once the device is issued;
  Routers that do not offer account mode keep the registration-code flow.
- New device requests appear as a confirmation dialog on the desktop. Settings
  lists the account's devices with Revoke, shows a notice for every new, adopted,
  or revoked device, and adds "require confirmation on every terminal" (off by
  default) for computers that must approve each device themselves. A revocation
  made while offline is delivered when the link returns.
- The remote web client signs in with an AccessKey, shows up front which
  computers can approve, switches between the account's computers on one device,
  and explains when a computer has not accepted the device yet.
  `agent-host-cli` can confirm devices through its admin socket
  (`--confirm-devices`, `--strict-devices`) and enroll with a key read from a
  0600 file, stdin, or the environment.
- The remote-control Gateway can send redacted push notifications through APNs
  and FCM when its operator configures credentials: approval and input requests,
  finished and failed turns, carrying only the event kind and ids, never
  conversation content. Push stays off without credentials.
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
- Automatic learning is available, off by default: after a conversation settles
  or compacts, the model you choose reads only your own messages and proposes
  notes into a Suggestions tab, where Keep makes one memory and Discard erases
  it. A daily token budget caps the cost and Settings shows today's usage; the
  switch, the model, and the budget stay on this device.
