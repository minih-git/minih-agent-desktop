# ADR 0339: Session cache keep-warm

- Status: Accepted
- Date: 2026-10-31
- Relates: [ADR 0323](0323-plugin-owned-session-titles.md), `docs/plugin-plan/runtime/turn-continue`

## Context

A long conversation is expensive to resume. Measured on this machine against
Minih Router (turn-level `usage_json`, first request of each turn, idle time
since the previous request), a Claude model reads

| idle time | cache-read share of the prompt |
| --- | --- |
| 5–15 min | 84% |
| 25–35 min | 52% |
| 45–55 min | 44% |
| 55–65 min | 31% |
| > 65 min | ~1% |

The lifetime is about one hour and the hit rate decays the whole way, so the
value of a warmer cache is real but strictly time-bounded. The one hour is the
provider's, not ours: pi-ai 1.1.0 defaults `cacheRetention` to `short`
(Anthropic's five minutes) and the main request path never passes it, so what we
observe comes from the Router's affinity window (default `fixed`, TTL one hour,
counted from the last successful request) and from the upstream vendor.

`docs/plugin-plan/runtime/turn-continue` settled a related question: a plugin
that spends the user's money must appear in the conversation, and silent
injection is refused. A keep-warm request is exactly the case that principle does
not cover — it spends money and must *not* appear in the conversation, because
the only visible artefact would be a message the model never answered. That
tension is what this ADR decides.

## Decision

**The host refreshes a session's prompt cache by itself, and a plugin only
schedules it.**

1. A new plugin API, `pi.session.keepWarm({ sessionId })`, under a new
   permission, `session.keepWarm`. It answers `{ status: "warmed", usage,
   cacheReadRatio }`, `{ status: "skipped", reason }` or `{ status: "failed",
   reason }`. The host is authoritative: it refuses with a named reason rather
   than allowing a request it knows cannot pay off.
2. The request replays the session's **last real request prefix** plus one fixed
   user message (`Reply with OK.`), assembled by the same code the turn path uses
   (`packages/agent-runtime/src/provider-request.ts`): same headers, same
   affinity identity, same extension provider hooks, same tools, same thinking
   parameters, same output ceiling. Anything else would make the provider write a
   new cache entry instead of reading the old one, and the user would pay twice.
3. **Prefix fingerprint guard.** A turn records a digest of the prefix the
   **next** request will start from — wire API, endpoint, provider, model, and
   the transcript the adapter receives — in a ledger owned by the sidecar process
   (`packages/agent-runtime/src/keep-warm.ts`). It is written when the turn
   settles, not when the request goes out: at request time the transcript does
   not yet hold the answer the next request will resume after, so a digest taken
   there could never match. The ledger also keeps a compressed, detached copy of
   that settled context. Keep-warm replays this snapshot and verifies its digest,
   rather than reconstructing message order or learned-memory sections from
   current history. A separate configuration digest still refuses model,
   thinking, mode, tools, skills, provider and instruction changes.
   The digest covers what an adapter writes, not what this runtime keeps. Each
   message is projected to a whitelist checked against pi-ai 1.1.0:
   `role`, `content`, `sections`, `toolsAdded`, `toolsRemoved`, `toolCallId`,
   `toolName`, `name`, `isError`. The two non-obvious entries are what makes the
   guard real: a transcript system message carries an empty `content` and its
   prompt in `sections` (rendered by `utils/text.ts`), and the tool declarations
   arrive as `toolsAdded`/`toolsRemoved` deltas (`utils/transcript.ts`, read by
   both the Anthropic and the completions adapters). A whitelist of
   role/content alone would have been blind to every prompt change — the date,
   a memory note, a mode switch — and to every tool-set change, such as an MCP
   server dropping or a plugin being disabled. Everything outside the whitelist
   is this runtime's bookkeeping: usage counters, api/provider/model tags, ids,
   timestamps, stop reasons, error text. `responseId` is written by the adapters
   and replayed by none of them (the Responses adapter sends no
   `previous_response_id`), so it stays out; an adapter that starts replaying it
   has to add it here.
   A new real prompt invalidates the previous record before execution; only a
   successfully completed turn replaces it. Failed or aborted turns cannot warm
   a stale snapshot.
4. The ledger lives in the sidecar, not in the runtime instance: the idle sweep
   reclaims a runtime after thirty minutes, and the first request is due at
   fifty. A rebuilt runtime uses the settled snapshot even when persisted
   steering order or the current learned-memory index differs. Snapshots are
   gzip-compressed in memory, replaced on each successful turn, removed on
   explicit disposal and pruned after the cache lifetime. Nothing is persisted.
   Restarting the app empties the ledger and answers `no_prior_request`.
5. **One storage rule for user messages.** Every path that creates a user
   message stores it in the same content form — a text block array — because that
   is what pi produces for a prompted message and what the request then carries.
   Two paths bypass pi's normalization (a steering message and the internal
   message that starts an approved plan), and they used to store a bare string;
   since the two forms serialize differently on the wire, a rebuild could not
   reproduce either. `replayableUserContent` is now applied where a message is
   created, so "how a user message is stored" has one answer and a rebuild does
   not have to know where a message came from.
6. **A rebuilt runtime must replay the same bytes.** Rebuilding from host history
   used to hand a user message to the adapter as a bare string where the live
   turn had stored — and sent — a text block array. Those are not the same
   request (verified against the completions adapter, which serializes them
   differently), so every resume after the idle sweep started a new provider
   cache entry, and no warm request could ever be verified. `historyToEntries`
   now reconstructs the message in the form the live turn stored. This is a
   change outside this feature's own surface: a resumed session now sends the
   bytes it originally sent instead of a re-shaped equivalent.
7. The request is **isolated from the turn**: it writes no message, appends no
   transcript row, runs no tool, emits no event, triggers no turn hook, no title
   generation, no silent re-run and no Plan/Goal progress continuation, and it
   does not touch the session's activity or unread state. It stops at the first
   usage event the protocol reports (Anthropic reports usage in `message_start`)
   and reads to the end only where the protocol cannot do better.
   **Its output ceiling is never lowered.** A smaller `max_tokens` is not
   harmless: a gateway that translates a Responses `reasoning` request into
   Anthropic thinking would see it below the thinking budget, and a changed
   thinking parameter invalidates the message-level cache the request exists to
   refresh — paying for a full cache write and a low read share. The ceiling
   therefore stays exactly the one the real request carried (recorded with the
   prefix), and a protocol that cannot report usage early pays for one short
   answer instead.
8. A real turn always wins: `agent.prompt` aborts an in-flight keep-warm request
   before it asks for the runtime, and a keep-warm request never queues, never
   retries and never delays a message.
9. Every answer names the model it was about (`model: { providerId, modelId }`,
   on `warmed`, `skipped` and `failed` alike). A caller enforcing its own model
   scope has no other honest way to learn it: the session read APIs a plugin can
   reach (`session.read.own`) only see sessions that plugin imported, and
   widening a paid API's reach to answer "what model is this" would be the wrong
   trade. The cost of that choice is stated below.
10. Spend is recorded in its own table (`keep_warm_usage`, schema v28) with no
   turn row and no transcript row, and it is counted into the token-usage
   history with `keepWarmRequests` / `keepWarmTokens` / `keepWarmCostUsd` beside
   it so the two remain distinguishable.

## Why silence is acceptable here, and what replaces visibility

The turn-continue principle exists because a message in the conversation is the
only place a user learns that a plugin spent money. Keep-warm replaces that with
two things the conversation cannot provide:

- **A permanent, per-session state in the composer.** The plugin's control shows
  the switch, the next request time, today's spend and the reason the schedule
  stopped. It is visible whenever the user looks at the session, which is when
  the spend matters — unlike a message buried in a long transcript.
- **A durable ledger.** Every attempt, including refusals, is a row the usage
  history counts, so the spend is auditable after the fact regardless of what any
  plugin displayed.

What is given up: a user who never looks at the composer learns nothing. That is
why the ceilings are fixed in the design rather than left to the plugin —
four consecutive requests without a real turn, one dollar a day per session,
stop below 50% cache-read share, nothing under a 20k-token context — and why the
switch is off by default for every session.

## Cost and risks

- **Cost.** One request per 50 minutes per enabled session: the whole prompt is
  read from cache plus a few hundred tokens of cache write, order of a cent for a
  50k-token context on Claude's published rates. The daily ceiling bounds it per
  session; nothing bounds the number of enabled sessions, which is the user's
  own choice and visible per session.
- **A plugin that rewrites the system prompt every turn.** A trusted extension's
  `before_agent_start` hook can change the prompt (or its tool set) after the
  turn settled, so nothing here can predict the prefix the next request will
  start from. The failure is contained rather than prevented: the request still
  goes out with whatever prefix the host assembles, and the plugin's own
  "stop below a 50% cache-read share" rule ends the schedule as soon as the
  provider reports that the prefix was rewritten instead of read.
- **Steering messages are re-ordered by a rebuild.** A steering message is
  recorded by the host when the user sends it — while a reply is still streaming
  — but pi injects it after that reply. A rebuilt runtime therefore places it one
  message earlier, the digest differs, and the guard refuses. Safe, and the only
  sessions affected are those steered mid-turn.
- **Rebuild fidelity.** The fix in decision 6 relies on the transcript carrying
  the same content form the live turn stored. A message stored by another path
  (an imported session, a hand-written transcript row) may not, and then the
  guard refuses — which is the safe half of the trade, not a silent miss.
- **Prefix drift.** A prompt section that changes on its own (today's date,
  learned memory) makes the guard refuse. That is the correct outcome, but it
  means a session can stop warming for a reason the user did not cause; the
  refusal is shown, not hidden.
- **Non-Anthropic protocols.** Only Anthropic reports usage before the message
  completes, so only there is the request truly free of generated tokens. The
  other supported protocols are read to the end at the same output ceiling a real
  turn used, so each keep-warm request pays for one short answer — a few hundred
  tokens of thinking and a handful of visible ones, not the whole conversation.
  Buying a smaller bill by lowering `max_tokens` was refused: on a gateway that
  translates Responses `reasoning` into Anthropic thinking it would change the
  thinking budget and break the very cache the request refreshes. Protocols
  outside that set are refused (`protocol_unsupported`) rather than guessed at.
- **Affinity.** The request carries the same `sessionId`, affinity headers and
  `prompt_cache_key` as a real turn, so it also extends the Router's one-hour
  affinity window. That is a beneficial side effect, not a goal, and nothing here
  depends on it.
- **Model scope is enforced after the first answer.** The plugin's "Claude
  only" setting cannot know a session's model before a request runs, so an
  enabled session on another model costs one kept request before it stops. The
  host's own `protocol_unsupported` refusal already covers protocols that cannot
  report usage; the remaining exposure is one small request per such session,
  bounded by the daily ceiling.
- **Restart.** A restart loses the ledger, so warming pauses for sessions that
  were idle before it. A turn restores it. No data is lost; only the opportunity
  to warm is.

## Alternatives refused

- **A plugin sending `agent/prompt` with a hidden message.** It would be a turn:
  transcript row, hooks, title generation, unread state, and a message the model
  answers. Refused by the turn-continue principle and by the requirement that the
  conversation not change.
- **Reusing `continueTurn`.** Same failure mode: it is the resumption of a real
  turn, with everything a turn implies.
- **Storing the spend on a synthetic turn row.** It would pollute
  `usage.listTurns`, appear in the transcript's turn accounting and make a
  keep-warm request indistinguishable from work the user asked for.
- **Keeping the runtime alive to keep the prefix in memory.** It trades the
  ledger for memory: a resident runtime per session for the whole day, which is
  what the idle sweep exists to prevent.
