# ADR plugin-host-capabilities: Six host capabilities, one permission each

- **Status**: Accepted for implementation (2026-11-17). B-0 registered the
  permissions; B1 implements credentials, B2 implements inbound webhooks,
  B4 implements `notify.center`, and B6 implements plugin scheduling. Other
  capability groups retain their separately documented implementation status.
- **Date**: 2026-11-17
- **Related**: ADR 0005 (user-installable plugins) · ADR 0008 D009 (the plugin
  process is not OS-sandboxed) · ADR 0074 (native notification permission) ·
  ADR 0088 (declared file scope) · ADR 0115 (host-owned clipboard history) ·
  ADR 0208 (native consent for desktop control) · ADR 0211 (Plan-safe plugin
  actions) · ADR 0257 (plugin real-time capabilities) ·
  [ADR bot-sessions-and-steward](bot-sessions-and-steward.md) (the task
  surface, §4.19a) · ADR 0330 (durable prompt reminders)
- **Specs**:
  [07-plugins/02](../spec/07-plugins/02-plugin-manifest-schema.md) ·
  [07-plugins/03](../spec/07-plugins/03-plugin-api.md) ·
  [07-plugins/04](../spec/07-plugins/04-plugin-security.md) ·
  [07-plugins/13](../spec/07-plugins/13-plugin-permissions-matrix.md) ·
  [03-runtime/04](../spec/03-runtime/04-data-storage.md)

## Context

The plugin surface is complete for plugins that read, transform, and display:
files, sessions, providers, models, themes, the panel, the bus. It is empty for
the other kind of plugin — the one whose job is to *hold* something on the
user's behalf: an API token for a mail server, a database socket, a mailbox
address something else posts to, a clock, a task the plugin started, a line in
the user's inbox.

Today every one of those is built *inside* the plugin process, because
`manifest.main` runs with raw Node built-ins (ADR 0008 D009). A plugin can open
a TCP socket, listen on a port, and keep a token in its own settings file. That
is not a boundary the host can review, audit, or withdraw: the user cannot see
what is held, no permission appears at install, and disabling the plugin does
not necessarily close what it opened.

The design rule that follows is the one the existing host-owned surfaces
already use (`net.websocket`, `keyboard.globalShortcut`, the clipboard history
of ADR 0115): **the host holds the resource, the plugin holds a permission and
a handle.** A credential, a listening socket, a public path, a timer, a task, a
mailbox entry — each is host state. The mediated API does not hand the stored
credential, socket, or clock to the plugin. This is not OS containment (§3).

Six capability groups cover the requests collected from first-party plugin
authors. None can be expressed by an existing permission, and two would be
actively dangerous as unnamed plugin behavior: a plugin-opened port appears in
no permission list, and a plugin-held credential is a token the user cannot
rotate through Settings.

## Decision

### 1. Eight permissions, six groups

| Group | Permissions | Manifest field | Resource the host holds |
|---|---|---|---|
| Credentials | `credentials.use` | `contributes.credentials` | The secret value |
| Raw TCP | `net.tcp` | `net.tcp` | The socket |
| Inbound webhooks | `inbound.webhook` | `contributes.webhooks` | The listener, the path, the token |
| Timers | `scheduler` | `contributes.schedules` | The clock |
| Host-owned outbound lists | `mail.draft`, `notify.center` | — | The list and its rows |
| Tasks | `tasks.read`, `tasks.manage` | `tasks` | The task and its session |

Every name is joined to `PLUGIN_PERMISSIONS`, and every name carries a risk
tier in `PLUGIN_PERMISSION_RISK`. The tier map is a `satisfies
Record<PluginPermission, PluginPermissionRisk>` clause, so a permission added
without a tier is a compile error rather than a capability that reaches the
install sheet looking harmless. An *unrecognised* name reads as `high`
(`pluginPermissionRisk`), because a capability the host cannot classify must
never look safer than one it can.

Risk tiering:

- **high** — `credentials.use`, `net.tcp`, `inbound.webhook`, `tasks.manage`.
  The host holds the secret, the socket, the public path or the task on the
  plugin's behalf, so the grant is the whole boundary.
- **medium** — `scheduler`, `mail.draft`, `notify.center`, `tasks.read`. The
  host owns a bounded queue the user can see and stop; drafting never sends,
  a timer spends no quota, and the read path has no write reach.

### 2. The permission is the switch, the manifest is the range

Same rule as `net.domains` and `manifest.fs`: a name says whether the plugin
may act, a manifest field says how far, both are shown beside the permission at
install, and **an absent field grants nothing**. A field nobody may use fails
manifest validation instead of being silently ignored.

### 3. Bounds the host enforces

These are the guardrails. Each is enforced by the host, not by the plugin, and
each is stated in the install review.

**Credentials (`credentials.use`).**

- A slot is user-filled in Settings, never plugin-written through a host API.
  There is no credential read API; host-generated responses, errors and audit
  records do not disclose stored values.
- The existing secret store holds the value, never SQLite (spec
  `03-runtime/04` §10). Its at-rest design is unchanged.
- Injection happens only on a host-owned egress path the plugin names by
  `credentialRef`, and only when the target is inside both the slot's `scope`
  and the plugin's own declaration: `manifest.net.domains` for HTTP and
  WebSocket, a `manifest.net.tcp` endpoint for the IMAP login. A slot without
  `scope` is injected nowhere.
- This is an auditable API boundary, not an OS sandbox or protection against a
  malicious plugin running Node with the user's file permissions. Install only
  trusted plugins. A remote service may echo the value in a response body, a
  WebSocket frame, or the transparent TCP stream after an IMAP login; the host
  does not filter those application payloads.
- A slot the Settings sheet cannot render (no kind, no fields, duplicate field
  key) fails manifest validation: a dead permission is an authoring slip.

**Raw TCP (`net.tcp`).**

- Endpoints are literal `{ host, port, tls }`. No wildcard, no port range, no
  bare `*`; a duplicate `host:port` is refused. `tls` is required, because the
  host neither upgrades nor downgrades a connection on its own.
- **At most four connections open at once per plugin.** The four is a
  concurrency ceiling, not a list cap: the endpoint allowlist has no entry
  limit, so an author with ten servers does not have to choose four.
- The plugin receives a connection handle and events. It never receives a
  socket, a stream, or a way to read the TLS session.
- A `credentialRef` on a TCP connect makes the host perform the IMAP login
  itself, and only over implicit TLS: it reads the greeting, negotiates PLAIN
  or LOGIN, and hands back `authenticated: true` alone. The login exchange stays
  in the host — no `data` event, error text or audit field carries the value or
  the transcript — but the connection after it is the same transparent stream
  as any other TCP connection, so a mailbox server can echo the password back
  and the host neither inspects nor redacts it. A `tls: false` endpoint is
  refused, and nothing about STARTTLS, XOAUTH2 or SMTP is offered.
- Every connection closes when the plugin unloads, is disabled, or crashes.
- The user's outbound HTTP proxy does not apply to these connections, and the
  install review says so.

**Inbound webhooks (`inbound.webhook`).**

- The host owns the listener, the path and the token. A webhook without a token
  is not registered at all; the token is a host-generated secret, compared in
  constant time, and rotating it is a Settings action.
- The listener boundary is amended by
  [ADR plugin-webhook-listener-boundary](plugin-webhook-listener-boundary.md):
  LAN mode binds all interfaces and applies a bounded source-address filter.
  It does not guarantee that every public-network source is excluded.
- Transport is plain HTTP. That is disclosed at install and in Settings with
  the same wording as a non-loopback HTTP MCP endpoint (ADR 0142): anything on
  the path can read it, so the token is a filter, not confidentiality.
- Request bodies above 256 KiB are refused with `413`; more than 120 accepted
  requests per minute per webhook are answered `429`. Both ceilings can be
  lowered in the manifest, never raised.
- The plugin receives only requests the host already accepted, as events. It
  cannot answer them; the host answers `202`.

**Timers (`scheduler`).**

- One timer per declaration, either a fixed interval or a five-field cron
  expression — never both. The floor is one minute; a faster declaration fails
  validation rather than being rounded.
- Tick resolution is the host's. Timers are not a model turn: a tick calls the
  plugin's handler and spends no tokens.
- `runWhen: "idle"` lets the host wait for the user to be idle; `always` is the
  default. A timer does not fire while the plugin is disabled or unloaded, and
  missed ticks collapse into one fire at the next opportunity instead of
  replaying a backlog.
- Consecutive failures stop the timer and surface it on the Plugins page,
  matching the supervised-service rule.

**Host-owned outbound lists (`mail.draft`, `notify.center`).**

- `mail.draft` writes a draft into the host's draft list. **There is no send
  path**, in this decision or behind a second permission.
- `notify.center` writes one row into the durable notification inbox, naming the
  plugin. The family has two kinds: **`plugin.alert`** for one event the user
  should see now, and **`plugin.digest`** for one row standing for a batch the
  plugin rolled up; the host also folds events exceeding the hourly budget.
  It is separate from
  `notify`, which raises a toast or a native banner and persists nothing; it is
  also not a `prompt.*` row, since nothing is waiting on an answer.
- Both are bounded like every other host queue: the inbox keeps its 200-row cap
  and is cleared by the same user action, and a plugin uninstall removes its
  rows.

**Tasks (`tasks.read`, `tasks.manage`).**

- `tasks.read` lists the roster and the ledger facts, read-only.
- `tasks.manage` creates and drives the plugin's own tasks. The effective
  permission mode is `min(manifest.tasks.manage.maxPermission, the employee's
  own mode)`, so a declaration can only narrow what the employee was already
  allowed to do.
- Omitting `maxPermission` means `accept-edits`. **`auto` is never implied**
  and has to be written down; when it is, the install review asks for it
  separately from the permission list, because it is the one declaration that
  removes the user's own approval step from work they did not type.
- A plugin cannot manage a task it did not create, and cannot exceed the
  employee's mode by any argument.

### 4. Storage: schema v43

The capability rows live in host-owned SQLite: the `plugin_id` label on the task
surface and on the notification inbox, and three tables for the capabilities
that need state across a restart. `notifications` is rebuilt because its
`session_id` must become nullable (a plugin entry has no session) and SQLite
cannot relax a `NOT NULL` or widen a `CHECK`. The plugin family is
`plugin.alert` / `plugin.digest` with `plugin_id`, `title`, `body`,
`link_json` and `dedupe_key`, tied to the rest of the inbox by
`CHECK ((kind LIKE 'plugin.%') = (plugin_id IS NOT NULL))` — a family rule, not
a second list of kind names to keep in sync. **The rebuild runs with
foreign-key enforcement on**, and therefore discards inbox rows whose session is
already gone; the user authorized discarding them, since an entry about a
deleted session can be shown against nothing.

The same step adds `tasks.plugin_id` and three tables: `plugin_webhook_events`
(one accepted delivery per row, with the peer address and a `body_ref` — the
body is *not* stored in SQLite), `plugin_schedules` (last attempt, consecutive
failures and a `paused` brake, never the declaration, which stays in the
manifest) and `plugin_tcp_usage` (byte totals per plugin, host, port and day,
not an event log). Details, DDL and the idempotency rules live in spec
`03-runtime/04-data-storage.md` §4.14, §4.19d, §4.19e and §7.

**Tasks keep `origin IN ('steward', 'direct')`.** An earlier draft of this
decision widened the check with `'plugin'`; that is withdrawn. `origin` records
which workbench path dispatched the task — `steward` for the pre-1.7.0
confirmed card, `direct` for the surface a person uses — and a plugin-initiated
task arrives through that same direct path. The plugin's involvement is
provenance of a different kind, so it is a nullable `plugin_id`, which needs no
rebuild, rewrites no historical row, and cannot be confused with the two
existing values.

### 5. What slice B-0 implements

B-0 is registration, and only registration:

- the eight names in `PLUGIN_PERMISSIONS` and the risk tier of every permission
  in `PLUGIN_PERMISSION_RISK`;
- the manifest fields `contributes.credentials` / `webhooks` / `schedules`,
  `net.tcp` and `tasks`, with their install-time shape validation, their
  bounds, and the rule that each field requires its permission;
- `packages/plugin-sdk` types and validators for the shapes above.

The original B-0 slice executed none of those capabilities. B1 subsequently
implements credential storage, status, and injection on host-owned fetch and
WebSocket calls, and the host-performed IMAP login of a credential-bearing
`net.tcp` connect; B2 implements inbound webhooks; B4 implements
`pi.notify.center`; B6 implements plugin scheduling. `mail.draft` and
`tasks.*` retain their separately documented implementation status.

## Consequences

- A plugin can ask for these six and the user can see, bound, and withdraw each
  one. Previously the same behavior was invisible plugin code.
- The host gains six long-lived resources it did not own: secrets, listening
  sockets, endpoint allowlists, timers, inbox rows, tasks. Each needs an owner
  and a teardown path (unload, disable, crash, uninstall, restart), which is the
  larger half of the implementation work.
- A permission is still a contract and a disclosure, not containment: a plugin
  main process with raw Node can open its own socket whatever `net.tcp` says
  (ADR 0008 D009). What changes is that the reviewable path exists and the
  unreviewable one is no longer the only one.
- The risk map is now a required row per permission. Adding a capability costs
  one line in two tables, and forgetting the second is a compile error.
- The inbox gains a second owner (a plugin) next to the session. Every consumer
  of `notifications` — renderer list, unread count, mark-read, clear, prune —
  must handle a row with no session and no turn.
- B4 made `Notification.session_id` and `session_title` optional and loads
  plugin fields, so a row without a session does not fail the entire list.
- `idx_notifications_plugin_dedupe` enforces per-plugin deduplication when a
  dedupe key is supplied.

## Alternatives

- **Let the plugin own its own socket, port and token.** Rejected: that is the
  status quo, and it is exactly what the user cannot review. Disabling the
  plugin would not close a port the host never knew about.
- **A secret read API (`pi.credentials.get`).** Rejected: an explicit read API
  would make accidental logging and forwarding easy. Host-mediated injection
  avoids returning the stored value; it does not sandbox malicious plugin code.
- **One `net.raw` permission covering TCP, UDP and TLS.** Rejected: TCP with a
  literal endpoint is reviewable; UDP is a different failure mode (no
  connection, spoofable source) and would need its own bounds, so it is not
  folded in.
- **Cap the `net.tcp` allowlist at four entries.** Rejected: the constraint
  that matters is four *open connections*, which bounds host memory and file
  descriptors. A four-entry list would bound the author instead, and push a
  plugin with ten servers back to opening its own sockets.
- **A webhook token only on non-loopback addresses.** Rejected: a loopback
  address is reachable by every process on the machine, and a plugin needs one
  rule it can rely on. The token is mandatory everywhere.
- **`origin = 'plugin'` on `tasks`.** Withdrawn — see §4. It rewrites the
  meaning of an existing column, forces a `sessions`-style rebuild and a
  historical-row decision, and duplicates what `plugin_id` says without
  ambiguity.
- **`auto` as the default `maxPermission`.** Rejected: the plugin author would
  be choosing, silently, that the user's approval step disappears.
- **Reuse `notify` for inbox rows.** Rejected: `notify` is a transient banner
  with no storage and no owner; `notify.center` needs a durable row, a 200-row
  cap, an unread count and an uninstall path, and conflating them would give
  every plugin that shows a toast a permanent inbox entry.