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

- `tasks.read` lists sanitized roster and ledger facts, without prompts,
  conversation content or credentials. `tasks.manage` creates and drives only
  the plugin's own tasks; foreign tasks return `NOT_FOUND`.
- The effective mode is the minimum of the requested mode, manifest ceiling,
  employee mode and `accept-edits`; omitted request and ceiling default to
  `accept-edits`. Explicit `auto` requests are denied until action-based
  approval exists. A manifest may declare `auto`; the install/update review
  explains the current ceiling without a separate checkbox.
- A host execution policy applies to the task session and descendants. Built-in
  low-risk reads and, under `accept-edits`, workspace-contained Write/Edit may
  auto-allow; all other calls require individual approval. Plugin risk claims,
  delegated scope and session or persistent grants cannot loosen the policy.
  Workspace edits include overwriting and clearing content; command or external
  tool deletion and external operations require individual approval.

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
## 4. Multi-instance credential slots and the TCP ceiling (2026-11-23, 1.9.0)

This section amends two of the decisions above. Everything else in this ADR
stands.

### The problem

`contributes.credentials` describes *a* credential: one slot, one value. A
mailbox plugin therefore configures one account, while the work it exists for —
"watch my three inboxes" — needs several. The only ways out were a slot per
mailbox (the manifest cannot know how many the user has), settings the plugin
owns (outside the host's encrypted store, its audit trail, and its uninstall
path), or a second account the user has to fake by editing the same value back
and forth.

The second number is the same story from the other side. A mailbox plugin keeps
one idle IMAP connection per account so new mail arrives without polling. With a
four-connection ceiling, a five-mailbox plugin spends five of its budget on
being idle and has nothing left for the work.

### Decision

1. A slot may declare `multiple: { max }` (1..5). Absent keeps the released
   single-value slot exactly: same storage key, same `credentials.list` answer,
   same `credentialRef` spelling. Backwards compatibility is the hard
   requirement; the feature is additive.
2. Instances live in the encrypted secret store
   (`plugin:<id>:cred:<slot>#<instanceId>`) with their metadata in the existing
   per-plugin credential index. No schema change, and a `<slotId>` cannot
   contain `#`, so the reference grammar is unambiguous.
3. `credentialRef` addresses one instance as `"<slotId>#<instanceId>"`. A
   reference without an instance on such a slot is `CREDENTIAL_INSTANCE_REQUIRED`;
   a `#` suffix on a single-value slot is `INVALID_ARGUMENT`. The gate order on
   every path is unchanged: permission → egress allowlist → slot → `scope ∩ net`
   → value.
4. A plugin may name an instance, so it must be able to identify one. The
   manifest declares `labelField`, which must name a **non-secret** field, and
   `credentials.list` returns each instance's id, label, and non-secret field
   values. This is the one place a plugin reads something a user typed, and it is
   a deliberate exception: a mailbox address is how a plugin tells one account
   from another, and it is not the secret. Every `secret` field stays unreadable
   on every path.
5. Collecting a value stays a host act. `credentials.requestAdd` /
   `requestRemove` ask the host to show **its own** form; the value travels
   renderer → main → host-core and never through the plugin process. Three
   refusals bound the interruption: no dialog while the app window is not in
   front, one dialog at a time per plugin, `CREDENTIAL_LIMIT` at `max`, and a
   30-second cooldown after the user dismisses one — a modal covers the whole app,
   so an immediate retry would take the window from the user. An answered dialog
   starts no cooldown.
   `credentials:changed` is how the plugin learns to re-read the list.
6. Upgrading an existing single slot into a multi-instance one keeps the value:
   the host copies the stored blob into the first instance and only then removes
   the original, with an instance id derived from the slot so a retry finishes
   the same migration instead of adding a second instance. Downgrading folds the
   first instance back and removes the rest. Both directions are audited by id,
   never with a value.
7. `MAX_CONNECTIONS_PER_PLUGIN` rises from 4 to 8. The ceiling bounds the host's
   descriptors and memory; it was never a cap on the allowlist. The
   per-connection write buffer, connect deadline, and TLS rules do not move.

### Consequences

- A plugin upgrades from one mailbox to five without a manifest rewrite, and an
  existing single-account install keeps working with no migration of its own.
- The `credentials.list` answer grows a shape a plugin can branch on: a
  single-value slot still answers `{id, configured}`, so no released plugin sees
  a different payload.
- The dialog is a new way a plugin can reach the user. It is bounded by
  foreground presence, one-at-a-time ownership, a timeout, and an instance limit,
  and it is audited per call.
- Eight sockets per plugin is still a ceiling that keeps a runaway plugin from
  exhausting descriptors; it is not a per-host budget.

### Alternatives

- **A credential slot per account, declared at install.** Rejected: the manifest
  cannot know how many accounts a user has, so it would cap the feature at
  authoring time.
- **Let the plugin collect the values with its own form.** Rejected: that puts
  the plaintext in the process the host is protecting, and gives up the audit
  entry and the foreground rule.
- **Return only `instanceId` and no label.** Rejected: the plugin would be unable
  to say which account a row is, and would have to ask the user to remember an
  opaque id.
- **Raise the TCP ceiling to "no limit".** Rejected: a bound is what keeps one
  plugin's loop from taking the host's descriptors down with it. Eight covers the
  idle-connection design with room for the work the connection exists for.

## 5. A user-typed mail server (2026-11-24, 1.10.0)

This section amends the endpoint rule in §3 and adds one declaration to §4.
Everything else in this ADR stands.

### The problem

`net.tcp.connect` reaches only the literal endpoints in `manifest.net.tcp`, and
an IMAP credential is injected only into the hosts in the slot's
`scope.domains` — `net.anyHost` is deliberately not consulted for an injection.
A mailbox plugin therefore cannot reach a self-hosted or company mail server,
because no manifest can name a host the user has not chosen yet. The escape
hatches that exist are all worse: a slot per server freezes the choice at
authoring time, `net.anyHost` widens egress but still cannot carry the secret,
and letting the plugin collect the server itself hands it the decision of where
a stored password goes.

### Decision

1. `contributes.credentials[].userEndpoint: { protocols: ("imap" | "pop3")[] }`
   may be declared, on an `imap` slot only, non-empty and without duplicates. It
   reserves four **non-secret** field keys for the host — `server`, `port`,
   `protocol`, `security` — and a slot that declares a field of one of those
   keys is refused at install, so the plugin's own form can never write them.
2. The server belongs to the credential instance: the user types it in the
   host-owned form, next to the address and the password, and the host logs in
   with that instance's password at the endpoint stored in the same instance.
   The binding replaces the manifest allowlist and the slot scope for that
   endpoint, which is the whole point — there is nothing left for a plugin to
   point somewhere else.
3. `net.tcp.connect` with a `credentialRef` naming such an instance may omit
   `endpoint`; the host dials what the user stored. An endpoint the plugin does
   supply must equal the stored host and port exactly, otherwise
   `PERMISSION_DENIED`. A connection **without** a `credentialRef` can never
   reach a user-typed endpoint, because that path still requires
   `manifest.net.tcp`.
4. Values are validated by the host at save time, not only in the renderer: a
   bare hostname or IP literal (no scheme, port, path, whitespace or wildcard),
   a port from 1 to 65535, a protocol the slot declares, and `tls` or
   `starttls`. Private and LAN addresses stay valid — a company mail server is
   exactly who this exists for — and cloud metadata hosts are refused by the
   same list the egress policy uses. A blank `server` means "no custom server":
   the instance keeps the preset path, and whatever the form prefilled for the
   other three keys is dropped rather than stored.
5. Transport security is implicit TLS or STARTTLS, and the host enforces the
   upgrade instead of offering a fallback. A server that does not advertise
   `STARTTLS` (IMAP) or `STLS` in `CAPA` (POP3) is refused with a distinct code;
   the plaintext capabilities are discarded and re-read over TLS, so nothing an
   unprotected exchange claimed can decide how the password is sent; and any
   byte that arrives after the agreement aborts the connection, which is the
   STARTTLS injection this contract exists to stop. Certificate verification is
   never optional, and SNI is the server's name (an IP literal is verified as an
   address instead).
6. POP3 is a second login the host performs itself: `AUTH PLAIN` when `CAPA`
   advertises `SASL PLAIN`, `USER`/`PASS` otherwise, and `-ERR` is
   `CREDENTIAL_REJECTED`. After the server accepts, the stream belongs to the
   plugin exactly as for IMAP. There is still no SMTP, no plaintext login and no
   OAuth2.
7. A slot **without** `userEndpoint` is byte-identical to 1.9.0: same storage
   shape, same allowlist and scope checks, same connect result. No permission is
   added — `net.tcp` and `credentials.use` remain the whole switch — and the
   per-plugin connection ceiling still applies to a user-typed connection.

### Consequences

- A mailbox plugin can serve a self-hosted or company server without the host
  ever learning the host name at authoring time, and without a new permission.
- The credential becomes a two-part fact — a secret plus where it may be sent —
  which is what makes the binding meaningful. A rotated password and a changed
  server are saved together, so the pair cannot drift apart.
- `credentials.list` reports the four endpoint values as `publicFields`, so a
  plugin can name an account by its server without reading the password.
- The form gains a section only for slots that opted in; every other slot renders
  exactly as before.
- A user-typed mail connection reports its failures with a closed set of names
  (`CONNECT_FAILED`, `TLS_CERTIFICATE`, `TLS_FAILED`, `STARTTLS_UNAVAILABLE`,
  `CREDENTIAL_REJECTED`), so a user-facing message can say what to fix instead of
  "connection failed". Nothing in the upgrade phase invents a sixth name.

### Alternatives

- **Declare the servers in the manifest.** Rejected: it cannot know them, and a
  `net.anyHost`-wide slot would carry the secret to any host the plugin names.
- **Let the plugin collect the server with its own form and pass it in.** That is
  precisely the redirection this design forbids: the plugin would choose where a
  stored password is sent.
- **Allow plaintext, since the user asked for it.** Rejected: a password on an
  unencrypted stream is not a user preference, and STARTTLS covers the servers
  that do not offer implicit TLS.
- **Accept a self-signed certificate.** Rejected: it would make "the host
  verified the peer" mean nothing on the one path where a password travels.

## 6. No mailbox limit (2026-11-24, 1.10.0)

This section amends §4 point 1 and point 5. Everything else stands.

### The problem

`multiple: { max }` was bounded at 1..5 because a mailbox plugin was expected to
hold one idle connection per account under a four-connection ceiling. The plugin
now polls with short connections instead, so the connection ceiling no longer
dictates the account count — but the host still refused the sixth account, which
is a product limit invented by an implementation detail. The number a user needs
is "as many mailboxes as I have".

### Decision

1. `multiple` may omit `max`. Omitting it means the plugin sets no limit of its
   own; a declared `max` keeps exactly its released meaning, with the accepted
   range widened to 1..100.
2. The host keeps one internal ceiling of **100 instances per slot**. It is what
   protects the encrypted store and the per-plugin credential index from one slot
   growing without bound, and it is the count at which `CREDENTIAL_LIMIT` is
   returned. It is reported separately as `limit`, so `max` stays "what the
   manifest asked for" and a slot that declared none shows no "x of y".
3. `MAX_CONNECTIONS_PER_PLUGIN` stays 8. Lifting the account limit does not lift
   the concurrency ceiling: a plugin that opens a connection per account still
   runs out, which is the plugin's business to schedule around (short, staggered
   polls), not the host's to allow.
4. Existing manifests with `max: 1..5` behave exactly as before: same storage
   shape, same refusals, same `list` answer. A manifest that declared an invalid
   `max` is refused at install rather than at first read.

### Consequences

- A user adds as many mailboxes as they have; the plugin cannot cap them by
  declaration, and the host still cannot be made to hold an unbounded list.
- `credentials.status` / `credentials.list` gain an optional `limit` next to the
  optional `max`; a released plugin reading `max` sees the same number it
  declared.
- The Settings sheet shows a plain count for a slot with no declared limit and
  still disables "Add" at the host ceiling.

### Alternatives

- **Keep 5.** Rejected: nothing about the host needs it any more, and it forced
  users with six mailboxes to file a bug.
- **No ceiling at all.** Rejected: an unbounded list is an unbounded encrypted
  index and an unbounded settings page. 100 is far beyond a real user and still
  bounded.
- **Raise `MAX_CONNECTIONS_PER_PLUGIN` to match.** Rejected: the ceiling bounds
  descriptors and buffers, and a plugin needs to schedule its own connections
  rather than expect a socket per account.

## 2026-11-25 — a proxy per mail account

Context: a mailbox that is only reachable through a tunnel (Gmail IMAP behind a
local Clash, a company server behind a LAN gateway) could not be used at all. The
host dials raw TCP itself and consults no proxy — the system proxy settings
describe HTTP requests, and a raw socket is not one — so the only workaround was a
TUN-mode proxy on the whole machine.

### Decision

1. `contributes.credentials[]` with `kind: "imap"` may declare a **top-level**
   `userProxy: { types: ("http" | "socks5")[] }`. Top-level on purpose: a 1.10.0
   host ignores an unknown top-level slot key, so the same package still installs
   and runs there without a proxy, while an unknown key *inside* `userEndpoint`
   would have been refused.
2. The proxy belongs to the credential instance, exactly like a user-typed
   server: the host dials it only for a connection carrying that instance's
   `credentialRef`, and a connection without one can never reach it. `userProxy`
   is independent of `userEndpoint`, because the account that needs a tunnel
   (Gmail) is precisely the one that keeps the preset server.
3. The host owns five reserved field keys — `proxyType`, `proxyHost`,
   `proxyPort`, `proxyUsername`, `proxyPassword` — and refuses a manifest that
   declares a field of one of them. The first three are published back through
   `publicFields` (an account card can say "via 127.0.0.1:7897"); the two
   credential keys never are, and the renderer cannot prefill them either.
4. Values are validated at save time by the host, not by the form: all-or-nothing
   (no type means no proxy, and the other keys are dropped), loopback and
   private/LAN addresses allowed (that is the feature), cloud metadata hosts
   refused by the same list the custom server uses, no CR/LF/NUL, and at most 255
   bytes per proxy credential (RFC 1929).
5. HTTP opens a `CONNECT host:port` tunnel with optional `Proxy-Authorization:
   Basic`; SOCKS5 offers no-auth and, when the account has a login, RFC 1929
   sub-negotiation, then `CONNECT` with the address as a name unless the account
   stored an IP literal. Nothing is resolved locally: the name is what the proxy
   is for. Bytes a proxy reply carried past its own length belong to the next
   stage — for STARTTLS that is the greeting.
6. TLS is untouched: implicit TLS verifies the certificate against the mail
   host's name (never the proxy's), and STARTTLS negotiates on the tunnelled
   plaintext socket. There is no fallback to a direct dial, so a failing proxy
   fails the connection instead of quietly using another route.
7. Two closed failure codes join the five: `PROXY_FAILED` (unreachable, bad
   handshake, refused tunnel) and `PROXY_AUTH_FAILED` (407, SOCKS auth rejected).
   Constant messages; neither quotes a proxy reply or a credential.

### Consequences

- A user can point one mailbox at a local or LAN proxy without changing anything
  for the rest of the app, and without the plugin learning where its password
  went.
- Two more error names reach a plugin's message table, so a proxied account can
  say "your proxy is not answering" or "your proxy login is wrong".
- A proxy login travels unencrypted to the proxy hop. That is a property of both
  protocols, it is documented in the spec and said in the form hint, and it is
  why the feature is aimed at the user's own or their LAN's proxy rather than a
  remote one.

### Alternatives

- **Put the proxy inside `userEndpoint`.** Rejected: 1.10.0 refuses unknown keys
  there, so the same package would fail to install on the host the plugin still
  supports.
- **Use the system proxy settings.** Rejected: they describe HTTP requests, not
  raw sockets, and they are a machine-wide decision for an account-level problem.
- **Fall back to a direct dial when the proxy fails.** Rejected: it would report a
  working mailbox while the password left by a route the user did not choose.
- **Resolve the mail host locally and connect through the proxy by address.**
  Rejected: local DNS is exactly what a proxy in this position exists to bypass.

## 2026-11-25 — a catalog host floor that is actually read

Context: the plugin marketplace never enforced its host floor. A catalog entry
declares `minMinihAgent: ">=1.10.0"`, the comparison understood only a bare
version, and an unreadable constraint answered "installs fine" — which is how
1.9.0 installed a plugin built for 1.10.0 and broke.

### Decision

1. The floor is read through its range prefix: `">=X.Y.Z"` and a bare `X.Y.Z`
   both mean "at least X.Y.Z", with surrounding spaces tolerated.
2. Every existing caller already asks the same predicate — the install/download
   path, the update check and the `installable` flag a listing shows — so no
   call site changes; they simply start getting the right answer.
3. Any other range keeps the permissive answer this host has always given an
   unreadable floor, and is logged at warn level: refusing would hide a plugin
   from every host that cannot parse its spelling, which is a worse failure than
   the one being fixed.
4. The manifest-side `engines.minihAgent` is not gated by this host at all (it is
   normalised and stored, and the manifest schema documents it), so there is
   nothing to change there.

### Consequences

- A version pinned to a newer app is no longer offered, installed, or pushed as
  an update on an older host.
- The install dialog says "update the app" instead of showing a raw
  `PLUGIN_HOST_TOO_OLD` failure: the refusal is mapped to a localised message
  that names the required version when the host reports one.
- A publisher who writes a range this host cannot parse still reaches old hosts,
  and the warning makes the case visible instead of silent.

### Alternatives

- **Refuse any catalog entry whose floor cannot be parsed.** Rejected for now:
  that would hide plugins from hosts that are perfectly capable, and the
  permissive answer predates this fix.
- **Support the whole range grammar.** Rejected as scope: the catalog contract is
  "at least X.Y.Z", and a full semver-range implementation would be a bigger
  surface than the one the field is documented to carry.

## 2026-11-25 — a plugin may ask the user where to save one file

Context: a mailbox plugin receives an attachment as bytes and has nowhere to put
them. `pi.fs.writeText` writes text inside the sandbox under the plugin's own
`manifest.fs` rules, there is no binary write at all, and letting a plugin name
an absolute path would hand it the user's whole file system.

### Decision

1. `pi.fs.saveAs({ suggestedName, data, mimeType? })` opens the native "save as"
   dialog and writes exactly the one path the user picks. The permission is
   `fs.write`; no `manifest.fs` scope applies, because the user's choice in the
   dialog is the authorisation — the same rule as any other "pick a file" action.
2. The suggested name is a *suggestion*: the host reduces it to one path segment
   (separators, control characters and leading dots removed, 180 bytes at most,
   `attachment` when nothing usable remains) and offers that to the dialog.
3. Bounds: one file per call, 50 MiB at most, non-empty. The app's own data
   directory and a short list of system locations (`/System`, `/bin`, `/sbin`,
   `/usr/bin`, `/etc`, `/dev`, `/proc`, `/sys`) are refused with
   `SAVE_AS_FAILED`, so a clever name cannot reach the host's own state.
4. Cancelling answers `null` and writes nothing. The destination is never echoed
   to another surface, and the audit row records the byte count and whether a
   file was written — never the path.

### Consequences

- A plugin can save what the user asked it to save, and nothing else: one dialog,
  one file, one path.
- No new permission: `fs.write` already means "this plugin may put files on
  disk", and the dialog narrows it to a file the user chose.
- The write happens in Electron main, next to the dialog, so a cancelled dialog
  costs nothing on disk and no host RPC carries the bytes twice.

### Alternatives

- **A new `fs.writeAbsolute` RPC with a scope.** Rejected: it would let a plugin
  write anywhere its scope names without the user looking, which is exactly the
  danger the dialog removes.
- **Reuse `fs.writeText` with base64.** Rejected: it keeps the sandbox root (so
  the user's chosen folder is unreachable), and base64 inflates a 25 MiB
  attachment into a string the host would have to decode anyway.
- **Save into a fixed "downloads" folder without asking.** Rejected: the user
  asked to save an attachment somewhere specific; a silent location is worse than
  a dialog.
