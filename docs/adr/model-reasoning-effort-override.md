# ADR: Explicit per-model reasoning-effort compatibility

- Status: Accepted
- Date: 2026-10-24
- Scope: approved sections I/II selected upstream adaptation

## Context

OpenAI-compatible gateways do not consistently accept `reasoning_effort`.
Automatic endpoint/model compatibility protects common services, but cannot know
every relay's behavior. A provider-global switch would discard Minih's per-model
protocol choices; changing thinking levels would conflate capability with a wire
parameter.

## Decision

Add optional `ModelBinding.supportsReasoningEffort: boolean | null`. Absent/null
keeps automatic inference; true explicitly permits the parameter and false omits
it. Apply an explicit saved boolean after compatibility inference, only in the
effective Chat Completions adapter. A catalog's compatibility record is not a
saved override. Thinking capability and level selection remain independent.

Keep the field through binding normalization, storage, copy and config sync.
Existing JSON records need no SQL migration. Settings uses existing controls and
the effective per-model protocol, including its override of the provider format.
Responses/Anthropic thinking, Minih Router, URL mapping and fallback are unchanged.

## 2026-10-25 official endpoint amendment

Adapt upstream `8e8b99ee36bcdb3b0253641e492eafe79a31c4f9`: official
DeepSeek hosts keep pi-ai effort detection instead of forcing suppression. Parse
the hostname, not a URL substring. Other relays, including Minih Router, retain
the suppression and nonempty replay defaults; saved booleans still win. This
changes automatic request compatibility, not the gateway route, auth, model
capability, storage format or thinking-toggle semantics.

## Alternatives and consequences

Automatic inference alone cannot support unknown relays. A global switch cannot
represent mixed-protocol model bindings. A new transport/config subsystem would
be unnecessary: this is one additive binding field with existing ownership.

Old records remain readable. Older strict importers can reject new exports with
the additive field; silently stripping an explicit choice is not a compatibility
strategy. The owning runtime/schema specs and request-body tests define behavior;
this record is not proof of deployment or provider entitlement.
