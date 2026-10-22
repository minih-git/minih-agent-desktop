# ADR 0333: Chat References Outside the Allowed Roots Offer Reveal and Copy

- **Status**: Accepted
- **Date**: 2026-10-20
- **Related**: [ADR 0262](0262-chat-file-refs-open-in-the-file-view.md) ·
  [ADR 0172](0172-contained-in-chat-image-display.md) ·
  [04-ux/09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md) ·
  [05-security/01-security](../spec/05-security/01-security.md)

## Context

Every file operation in the app is contained: `fs/read`, `fs/open`, `fs/reveal`,
and the image reader all resolve a path through `realpath` and refuse anything
outside the open project, the session scratch store, and the attachment store
(ADR 0172). `fs/resolveRef` inherits that gate, so a chat reference to
`/Users/me/notes/todo.md`, `/etc/hosts`, or a sibling checkout resolved to
nothing and reported "outside the locations this app can access".

That refusal is correct about reading and wrong about intent. A reader who
clicks such a reference is usually not asking the app to open a file it must not
touch; they are asking *where is that?* The app already has the one capability
that answers it — `shell.showItemInFolder`, which asks the desktop shell to
select a path in Finder, Explorer, or the platform file manager. That call
neither reads the entry nor executes it.

The alternative was to keep refusing. It costs the user a manual search for a
path the reply already spelled out, and it teaches them that clicking a path in
a reply does nothing — which is how the transcript's file affordance stops being
trusted for the paths it *can* handle.

## Decision

1. **An out-of-root reference is an observation, not a match.**
   `fs/resolveRef` keeps returning `match: null` and
   `reason: "outside-allowed-roots"`, and adds `outside: { absolutePath,
   entryKind }` when the path exists. The probe is a `stat`: no content, no
   directory listing, no open. `match` stays `null` on purpose — every existing
   consumer routes on it, and a reference the app may not read must not become
   a file it can preview.
2. **A new channel shows it, and only shows it.** `fs/revealChatRef` resolves the
   path, confirms the entry exists, and calls `shell.showItemInFolder`. It never
   calls `openPath`, never reads, and never lists. `fs/reveal`'s containment
   checks are untouched; the new channel exists because it is a different
   promise, and folding it into the existing one would have weakened a guard the
   rest of the app depends on.
3. **It is local-only.** A remote session is refused outright, and
   `remote-ipc-safety` marks the channel as uncallable from a remote client:
   the path belongs to another computer, and revealing something on *this* one
   would be a lie. A remote `fs/resolveRef` never returns `outside` either, so a
   remote client is not told whether a path exists on the host.
4. **Only absolute and `~` paths.** `~` is expanded in main; anything else is
   refused before any filesystem call. A relative path has no meaning for a
   reveal, and accepting one would put the CWD in the decision.
5. **The renderer offers exactly two actions.** A reference with `outside`
   counts as confirmed, so it is a normal link, but its click and its context
   menu open the same two-item menu: **Reveal in Finder** (this channel) and
   **Copy path** (the absolute path). There is no "Copy relative path" because
   there is no relative spelling, and no open destination because nothing here
   may read the file.

## Why reading and opening stay refused

Showing a path leaks one bit — it exists — and the entry's kind. Reading it
leaks its contents, and opening it hands the path to an arbitrary handler
chosen by file association. Those are different consequences, and only the first
is what "where is that?" asks for. Keeping `match: null` is what makes the
boundary mechanical: no code path that receives a `match` can be reached with an
out-of-root path, so the file view, the host `file:` tab, the side browser, and
the image reader remain exactly as contained as before.

## Residual risk

A chat reference can now be used to test whether an arbitrary absolute path
exists on this computer: write `/Users/me/.ssh/id_ed25519` in a reply, click it,
and the menu appears or the restriction is reported. The attacker in that
scenario is the model, or whoever controls the text it prints, and the answer is
one bit either way.

Accepted, with limits:

- nothing is read, listed, opened, or executed, so the leak is existence and
  kind only — not contents, not permissions, not size;
- it takes a click. Nothing is probed while rendering: the transcript confirms
  only references that look like paths, in a session that may use local tools,
  and `fs/resolveRef` is not reachable from a remote client;
- the same one bit is already available to any local process the user runs, and
  to `fs/resolveRef` for every path inside the allowed roots.

## Why no extra deny list for `~/.ssh` and friends

A deny list would suggest the app protects those directories, and it would not:
the operation never reads them, so a "denied" answer would have to be a lie
about a path the shell can reveal anyway. Worse, a deny list is a promise to
enumerate sensitive locations correctly and forever — `~/.ssh`, `~/.aws`,
`~/.gnupg`, keychains, browser profiles, cloud-sync folders — and any omission
silently weakens the claim. The honest boundary is the one the app can keep:
this operation shows where something is, and never what it contains.

## Consequences

- A chat reference to any existing path becomes actionable: inside the roots it
  opens where it always did, and outside them it can be located and its path
  copied.
- The renderer's "restricted" toast now appears only for a path that is both
  outside the roots and absent, which is the only case where there is nothing to
  offer.
- One new renderer-facing channel, one new IPC key, and one new remote-safety
  entry. No plugin API, no new permission, and no change to any read guard.
- A remote host that predates this change simply never reports `outside`, so an
  older host degrades to the previous behavior rather than failing.
