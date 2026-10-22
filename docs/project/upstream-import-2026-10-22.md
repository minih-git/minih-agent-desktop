# Selected upstream reliability import: 2026-10-22

## Scope and provenance

Source repository: https://github.com/vastsa/PI-Desktop. The reviewed monitoring
range is `494b5f7c8f908aaf1f04bd5e86572dd32ec15167..eb74d68e3b82496513da970164e0942798f5c711`.
The Minih implementation starts from `c9e1744cfc103ff7849ce44327c868fcfedabefd`.
This is a selective content import, never a merge of upstream ancestry. The
complete imported baseline remains `0d235a91a7718c8b7c0b1b485dc603c2840d5645`.
The monitoring checkpoint means analyzed, not imported. Original contributors
retain attribution through the source revisions below.

| Source revision | Selected content |
|---|---|
| `1b1032c28794b1f3af6c9c242dc5f818a3e49bd9` | Resolve parent-checkout chat references to the isolated worktree copy |
| `549b67b990cf874c041e7146f3c4332b31a5d739` | Let an unpinned reading bookmark own pane reveal |
| `31caf50d0ad8001ba9a95885231508bc03136a57` | Search beyond a truncated file index for nonempty local `@` queries |
| `99bd282a41911e01a3e599c19869a4e43a5487da`, `a1427526710bb9e06e4e13523d01f0a363629d81` | Fail before opening OAuth without a registered MCP client or DCR; localize recovery |
| `d008073814aa54bb89261ca22bc5469721e17bb0` | Make the background-task row lead toggle output without changing other controls |
| `434e06f5d2382482bcc6bf065474b221d657a968`, `02aa5678ddb3d836230e0f2e7c569a8dcbc1154c`, `c6db17b881938f5f3c980e9bb48e1915dab94769`, `82ef18b28cefe74035450bd19408a19e31a9e7b6` | Bound certificate E2E baseline probing and escalate hung child termination |

## Minimal design and preserved behavior

- Adapt existing owners in place; no dependency upgrade, database migration,
  public Host RPC addition, generic filesystem refactor, or runtime TLS change.
- Rebase only a parent-checkout absolute file reference with an existing
  worktree counterpart. Keep final realpath containment, remote identities,
  directory references, and Minih outside-root locate-only behavior unchanged.
  Isolated-session preview paths remain absolute so they cannot reopen main.
- On pane reveal, an unpinned bookmark takes precedence over a stale follow flag.
  Preserve Minih's bottom-band bookmark sampling and all density/scroll rules.
- Keep the 8000-entry initial file snapshot. Only a truncated local file source
  with a nonempty query requests bounded deeper search after 150 ms. Preserve
  ignore rules, result ranking, old-query/session cancellation, truncation
  reporting, Minih IPC naming, and `#` session-target completion. Remote file
  sessions retain their snapshot until their protocol supports search.
- Without a stored OAuth client or DCR endpoint, emit an optional structured
  error code and localized recovery before opening an authorization URL. This
  does not add manual client registration or promise a nonexistent settings field.
- Use the existing shared Button for background-task row activation. Preserve
  session isolation, the 12-row limit, independent Stop/Dismiss actions, and
  bounded output/async handling.
- Keep certificate probes isolated and offline. A bounded original-failure
  observation is not proof that an optional-client-certificate repair passed;
  the actual repaired transport assertions still must pass. Preserve Minih's
  source aliases and credential/proxy/TLS checks.
- Preserve Minih brand/package/channel/data/update identity, Router behavior,
  local/remote boundaries, transcript density, narration previews and statistics.

## Excluded content

All plugin-only changes and plugin portions of mixed commits are excluded.
Do not import the upstream transcript-display modes, intermediate deprecated
command-folding preference, thinking shimmer, or their settings/config-sync
changes. Minih already owns different transcript-density semantics; this needs
separate product evaluation rather than a wholesale replacement.

## Development verification

Before fixes, run new regression cases against the old behavior where practical.
Then run the affected file-index, chat-reference, reading-position, MCP OAuth,
background-task interaction and child-exit tests. Build the changed shared,
i18n and host-runtime packages, typecheck Desktop, and lint changed code. Use
isolated local browser/Electron fixtures for deep completion, reading restore,
background-row pointer/keyboard behavior and certificate transport; never use
the installed user app or paid providers. Do not install a second dependency
environment. Full repository gates belong to a later authorized publication.

## Status

Implementation is complete in `fix/upstream-selected-20261022`, based on
`c9e1744cfc103ff7849ce44327c868fcfedabefd`. The main checkout moved independently
during this work; it was neither modified nor used as an integration candidate.
The following development checks passed on the uncommitted request worktree:

- 161 focused Node tests: MCP discovery/login/error reporting, workspace IPC and
  containment, file chips, transcript reading/navigation, background tasks,
  interaction contracts and controlled-clock child termination.
- Four host-runtime file-index tests and 12 i18n catalog tests. New reading and
  file-search regressions failed on the old implementation; MCP no-DCR
  regressions also reproduced its invalid browser URL and pending callback.
- Changed shared/i18n/host-runtime package builds, Desktop production build and
  Desktop typecheck; repository-scoped lint, style-token and whitespace checks.
- Isolated Electron editor path: deep file selection becomes a chip; duplicate,
  stale-query and stale-session results do not leak; Minih `#` completion works.
- Isolated reading position: warm/evicted bookmarks, real session range restore,
  and an unpinned bookmark with a stale `pinned=true` follow flag.
- Isolated background row interaction at 1280/700/390px: pointer and native
  Enter/Space, independent Output/Stop/Dismiss, bounded output and session scope.
- Isolated local certificate transport: original Electron failure before HTTP,
  repaired metadata discovery, proxy and bypass, origin refusal and cancellation.
- Documentation checks: 87 English/Chinese pairs and 606 pages, with only
  preexisting ADR format notes.

The first native-key test could not deliver input into a hidden Electron window;
the fixture now uses CDP native key delivery and all three widths pass. The
product remains a shared native Button, without redundant key handlers. One
old source-contract assertion was updated for the new bookmark ownership rule.

No dependency installation, upstream-history merge, commit, push, local-main
integration, user-app restart, packaging, release or deployment was performed.
Full repository/publication gates and Windows/Linux native acceptance were not
run. The complete-import baseline and monitoring checkpoint are unchanged.
