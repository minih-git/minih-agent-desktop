# ADR plugin-embeddings: Generate vectors with the user's own models

- Status: Accepted for implementation (2026-11-10, decision D686)
- Amends: 07-plugins/02-plugin-manifest-schema.md (permission list), 07-plugins/03-plugin-api.md (models.list, embeddings.embed), 03-runtime/04-data-storage.md (the model binding record)
- Related: `plugin-learned-memory-read`, `conversation-archive`, ADR 0339 (paid host-sent requests stay behind install consent)

## 1. Context

A plugin that indexes the user's notes needs vectors, and today it has to
obtain them itself: `personal-knowledge` asks the user to fill in a provider, a
base URL and the *name of an environment variable* holding the key. Every user
therefore configures the same gateway twice — once in Desktop, once in the
plugin — and the second copy lives in a file outside the app's own settings.

Two facts make that duplication unnecessary:

- Desktop already holds the provider rows, including the embedding models a
  Minih Router catalog publishes, and the credentials that go with them.
- Desktop already sends paid provider requests on a plugin's behalf for
  `pi.agent.complete`, under an install-time permission (`agent.complete`), with
  the credential never entering the plugin process.

What is missing is a way to say *which* saved models are vector models, and one
API that turns text into vectors without handing the plugin the key.

## 2. Decision

### 2.1 A model has a kind

`ModelBinding` gains an optional `kind: "chat" | "embedding"`. Absent means
`"chat"`, which is what every record written before the marker was, so no
migration runs and no stored row changes meaning.

- The gateway already classifies its own catalog (`categoryFor()` in
  `minih-router-control.ts`), so a model imported from Minih Router is saved as
  `kind: "embedding"` when the gateway says so. The user can change it on the
  model's own row in Settings.
- The host stores the answer and never interprets it. `host-core` keeps the
  field in the provider's `config_json`; `normalize_model_kind` writes `chat` as
  *absent* so one state cannot be spelled two ways, and an unknown value reads
  as chat.
- Config sync merges a provider as one aggregate of plain JSON, so the marker
  travels with the row and an older device that does not know the field keeps
  it — it neither errors nor strips it.

### 2.2 A vector model is never a conversation model

A model that produces vectors cannot answer a turn. Offering it in the session
composer, a subagent pin, the title model, the learning model or the follow-up
suggestion would only fail at send time, after the user picked it.

Every conversation choice therefore filters on `isConversationModel()`, and the
host refuses it too: `resolveRuntimeModel` rejects an embedding model for a
conversation launch, which is what keeps a stale selection from starting a
session that can never answer.

### 2.3 `pi.embeddings.embed` under a new high-risk permission

```
pi.embeddings.embed({
  modelKey: string,      // `${providerId}/${modelId}` of a ready kind="embedding" model
  texts: string[],       // 1..=64; one ≤ 8 KiB; 256 KiB in total
  dimensions?: number,   // optional, passed through when the endpoint supports it
}) -> { vectors: number[][]; modelKey: string; dims: number; usage?: { inputTokens?: number } }
```

- Permission `embeddings.run`, high risk: the text leaves the machine and spends
  the user's quota, the same tier as the other paid host-sent channels. Install
  review states both.
- The request is the OpenAI-compatible one — `POST <baseUrl>/embeddings` with
  `{ model, input, encoding_format: "float", dimensions? }` — because that is the
  one wire the gateway, a self-hosted Ollama and an OpenAI-compatible proxy all
  speak. A vendor-account OAuth provider and a native adapter (Anthropic, Gemini,
  Codex) answer `UNSUPPORTED_PROVIDER` rather than being guessed at.
- The credential is resolved inside Electron main and never reaches the plugin,
  a returned value, an error message, or a log line.
- Every bound is checked before the provider is called, so a malformed request
  costs nothing. Per-plugin pace: 120 calls a minute. Timeout: 60 seconds.
- The audit row carries the plugin, the model key, the text count, the character
  count, the vector width and the token usage — never the text and never a
  vector.

### 2.4 `pi.models.list` keeps its answer and gains a selector

Each model row reports `kind`. Called with no argument it lists conversation
models only — exactly what it always did — so a plugin written before this ADR
sees no change. `{ kind: "embedding" }` lists the vector models and
`{ kind: "all" }` lists both.

## 3. Consequences

- A plugin can index with the models the user already configured, without a
  second copy of a credential in a file the app does not manage.
- Two layers stay where they were: SQLite and the credential remain the host's,
  and the plugin receives neither. A plugin cannot learn a key by calling this
  API, and cannot make the host call an endpoint the user did not configure.
- Only OpenAI-compatible endpoints are served. A native or OAuth provider is a
  documented refusal, not a silent fallback to a different wire.
- A user who marks a model as an embedding model loses it from every
  conversation picker; the model row is the one place to undo that.
- The text still leaves the machine. Consent is at install time, the model is
  visible in the provider row the user owns, and the disclosure inside the
  plugin remains the plugin's responsibility (its own ADR and UI).
