import { randomUUID } from "node:crypto";
import { retryAssistantCall } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  RetryCallbacks,
  RetryPolicy,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { addSummaryUsage } from "./compaction-summary-input.js";
import { convertToLlm, serializeConversation, textFromContent } from "./pi-runtime-messages.js";
import type {
  CompactResult,
  CompactionPreparation,
  Result,
  RuntimeThinkingLevel,
} from "./pi-runtime-types.js";
import { CompactionError } from "./pi-runtime-types.js";

const SUMMARY_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const NEW_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of next steps]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

const MAX_SUMMARY_TOKENS = 0.8;

/**
 * The conversation request a `previous_on_switch` summary appends its
 * instruction to (D691).
 *
 * The provider caches a prefix, so a summary that reuses the bytes the previous
 * model already received — the same system prompt, the same tool declarations,
 * the same projected messages — reads the whole history out of that cache; only
 * the appended instruction is new. Everything here is copied from the request
 * that model sent, so nothing is re-derived and nothing can drift.
 */
export type SummaryConversationPrefix = {
  /**
   * The normalized transcript the conversation request sent: the leading system
   * message already carries the prompt and the tool declarations, so copying
   * these messages copies both.
   */
  messages: Message[];
  /** The cache key the conversation requests use, so the prefix lands there. */
  sessionId: string;
};

/** Extra knobs the runtime passes for one summary request. */
export type SummaryRequestOptions = {
  /** Request headroom of the summary model's window; overrides `settings`. */
  reserveTokens?: number;
  /** Reuse a warm conversation prefix instead of serializing the range. */
  reuse?: SummaryConversationPrefix;
};

async function requestSummary(
  messages: AgentMessage[],
  model: Model<Api>,
  reserveTokens: number,
  options: {
    previousSummary?: string;
    customInstructions?: string;
    errorLabel?: string;
    thinkingLevel?: RuntimeThinkingLevel;
    signal?: AbortSignal;
    retry?: RetryPolicy;
    callbacks?: RetryCallbacks;
    prompt?: string;
    outputRatio?: number;
    reserveTokens?: number;
    reuse?: SummaryConversationPrefix;
  },
  models: Models,
): Promise<Result<{ text: string; usage: Usage }>> {
  const summaryReserveTokens = options.reserveTokens ?? reserveTokens;
  const maxTokens = Math.min(
    Math.floor((options.outputRatio ?? MAX_SUMMARY_TOKENS) * summaryReserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const basePrompt = options.prompt ?? (options.previousSummary
    ? UPDATE_SUMMARY_PROMPT
    : NEW_SUMMARY_PROMPT);
  const summaryPrompt = options.customInstructions
    ? `${basePrompt}\n\nAdditional focus: ${options.customInstructions}`
    : basePrompt;
  // The carried summary is an instruction, not conversation: it rides with the
  // prompt in both shapes, so the cached prefix stays exactly the conversation.
  const carried = options.previousSummary
    ? `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`
    : "";
  const reuse = options.reuse;
  const context: Context = reuse
    ? {
        // No `systemPrompt`/`tools` here: those fields would make pi prepend a
        // second system message, and the prefix has to stay byte-identical.
        messages: [
          ...reuse.messages,
          {
            role: "user",
            content: [{ type: "text", text: `${carried}${summaryPrompt}` }],
            timestamp: Date.now(),
          },
        ],
      }
    : (() => {
        const conversation = serializeConversation(convertToLlm(messages));
        const promptText = `<conversation>\n${conversation}\n</conversation>\n\n${carried}${summaryPrompt}`;
        return {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
          }],
        } as Context;
      })();
  const requestOptions: SimpleStreamOptions = {
    maxTokens,
    ...(model.reasoning && options.thinkingLevel && options.thinkingLevel !== "off"
      ? { reasoning: options.thinkingLevel }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    // A reused prefix keeps the conversation's own cache identity and the
    // provider's default retention; the serialized prompt is a different
    // request with nothing to hit, so it asks for no retention at all.
    ...(reuse
      ? { toolChoice: "none" as const, sessionId: reuse.sessionId }
      : { cacheRetention: "none" as const, sessionId: randomUUID() }),
  };
  let response: AssistantMessage;
  const errorLabel = options.errorLabel ?? "Summarization";
  try {
    response = await retryAssistantCall(
      () => models.completeSimple(model, context, requestOptions),
      options.retry,
      options.signal,
      options.callbacks,
    );
  } catch (error) {
    if (options.signal?.aborted) {
      return {
        ok: false,
        error: new CompactionError(
          "aborted",
          error instanceof Error ? error.message : `${errorLabel} aborted`,
        ),
      };
    }
    return {
      ok: false,
      error: new CompactionError(
        "summarization_failed",
        error instanceof Error ? error.message : `${errorLabel} failed`,
      ),
    };
  }
  if (response.stopReason === "aborted") {
    return {
      ok: false,
      error: new CompactionError("aborted", response.errorMessage || `${errorLabel} aborted`),
    };
  }
  if (response.stopReason === "error") {
    return {
      ok: false,
      error: new CompactionError(
        "summarization_failed",
        `${errorLabel} failed: ${response.errorMessage || "Unknown error"}`,
      ),
    };
  }
  // Thinking-only / output-limited replies extract to "" via textFromContent
  // (thinking blocks are excluded). An empty checkpoint would look like a
  // successful compaction while silently discarding working context.
  const text = textFromContent(response.content);
  // A reused prefix carries the conversation's tool declarations, so a model
  // that answers with a tool call instead of prose produced no summary. Asking
  // the provider to forbid tool use is not available everywhere (`toolChoice`
  // is best-effort), so the reply is checked here as well.
  const calledTool = response.content.some((block) => block.type === "toolCall");
  if (reuse && calledTool) {
    return {
      ok: false,
      error: new CompactionError(
        "summarization_failed",
        `${errorLabel} failed: the summary model called a tool instead of writing the summary`,
      ),
    };
  }
  if (!text.trim()) {
    const limited =
      response.stopReason === "length"
        ? " (output limited before any summary text)"
        : "";
    return {
      ok: false,
      error: new CompactionError(
        "summarization_failed",
        `${errorLabel} failed: empty summary text${limited}`,
      ),
    };
  }
  return { ok: true, value: { text, usage: response.usage } };
}

export async function generateSummaryWithUsage(
  currentMessages: AgentMessage[],
  models: Models,
  model: Model<Api>,
  reserveTokens: number,
  customInstructions: string | undefined,
  previousSummary: string | undefined,
  thinkingLevel: RuntimeThinkingLevel | undefined,
  retry: RetryPolicy | undefined,
  callbacks: RetryCallbacks | undefined,
  signal: AbortSignal | undefined,
): Promise<Result<{ text: string; usage: Usage }>> {
  return requestSummary(currentMessages, model, reserveTokens, {
    ...(customInstructions ? { customInstructions } : {}),
    ...(previousSummary ? { previousSummary } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(retry ? { retry } : {}),
    ...(callbacks ? { callbacks } : {}),
    ...(signal ? { signal } : {}),
  }, models);
}

function compactFileOperations(fileOps: CompactionPreparation["fileOps"]): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections = [
    ...(readFiles.length ? [`<read-files>\n${readFiles.join("\n")}\n</read-files>`] : []),
    ...(modifiedFiles.length ? [`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`] : []),
  ];
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

export async function compact(
  preparation: CompactionPreparation,
  models: Models,
  model: Model<Api>,
  customInstructions: string | undefined,
  thinkingLevel: RuntimeThinkingLevel | undefined,
  retry: RetryPolicy | undefined,
  callbacks: RetryCallbacks | undefined,
  signal: AbortSignal | undefined,
  options?: SummaryRequestOptions,
): Promise<Result<CompactResult>> {
  let summary: string;
  let usage: Usage | undefined;
  if (options?.reuse) {
    // A warm prefix carries the whole conversation, so it covers a split turn's
    // two ranges at once: one request against the previous model's own bytes is
    // exactly what makes this compaction cheap (D691). The retained suffix is
    // summarized too, which only means the summary may mention work that is also
    // replayed — the messages themselves are unchanged.
    const result = await requestSummary(
      [
        ...preparation.messagesToSummarize,
        ...(preparation.isSplitTurn ? preparation.turnPrefixMessages : []),
      ],
      model,
      preparation.settings.reserveTokens,
      {
        ...(preparation.previousSummary ? { previousSummary: preparation.previousSummary } : {}),
        ...(customInstructions ? { customInstructions } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(retry ? { retry } : {}),
        ...(callbacks ? { callbacks } : {}),
        ...(signal ? { signal } : {}),
        ...(options.reserveTokens ? { reserveTokens: options.reserveTokens } : {}),
        reuse: options.reuse,
      },
      models,
    );
    if (!result.ok) return result;
    summary = result.value.text;
    usage = result.value.usage;
  } else if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    let history = "No prior history.";
    let historyUsage: Usage | undefined;
    if (preparation.messagesToSummarize.length > 0) {
      const result = await requestSummary(
        preparation.messagesToSummarize,
        model,
        preparation.settings.reserveTokens,
        {
          ...(preparation.previousSummary ? { previousSummary: preparation.previousSummary } : {}),
          ...(customInstructions ? { customInstructions } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(retry ? { retry } : {}),
          ...(callbacks ? { callbacks } : {}),
          ...(signal ? { signal } : {}),
          ...(options?.reserveTokens ? { reserveTokens: options.reserveTokens } : {}),
        },
        models,
      );
      if (!result.ok) return result;
      history = result.value.text;
      historyUsage = result.value.usage;
    }
    const prefix = await requestSummary(
      preparation.turnPrefixMessages,
      model,
      preparation.settings.reserveTokens,
      {
        prompt: TURN_PREFIX_PROMPT,
        errorLabel: "Turn prefix summarization",
        outputRatio: 0.5,
        ...(options?.reserveTokens ? { reserveTokens: options.reserveTokens } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(retry ? { retry } : {}),
        ...(callbacks ? { callbacks } : {}),
        ...(signal ? { signal } : {}),
      },
      models,
    );
    if (!prefix.ok) return prefix;
    summary = `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.value.text}`;
    usage = addSummaryUsage(historyUsage, prefix.value.usage);
  } else {
    const result = await requestSummary(
      preparation.messagesToSummarize,
      model,
      preparation.settings.reserveTokens,
      {
        ...(preparation.previousSummary ? { previousSummary: preparation.previousSummary } : {}),
        ...(customInstructions ? { customInstructions } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(retry ? { retry } : {}),
        ...(callbacks ? { callbacks } : {}),
        ...(signal ? { signal } : {}),
        ...(options?.reserveTokens ? { reserveTokens: options.reserveTokens } : {}),
        ...(options?.reuse ? { reuse: options.reuse } : {}),
      },
      models,
    );
    if (!result.ok) return result;
    summary = result.value.text;
    usage = result.value.usage;
  }
  const { readFiles, modifiedFiles } = compactFileOperations(preparation.fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  return {
    ok: true,
    value: {
      summary,
      tokensBefore: preparation.tokensBefore,
      ...(usage ? { usage } : {}),
      retainedTail: preparation.retainedTail,
      details: { readFiles, modifiedFiles },
    },
  };
}
