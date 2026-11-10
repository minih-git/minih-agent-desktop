import { Type } from "@earendil-works/pi-ai";

/**
 * Built-in cross-session delivery tools (ADR builtin-session-messaging) and
 * the session creation that gives them a target when none exists yet (ADR
 * session-create-tool).
 *
 * They reach another session's Agent through the host-owned delivery ledger.
 * The model resolves a session title through `SessionList`, addresses the real
 * Session ID because titles are neither unique nor stable, and creates the
 * session through `SessionCreate` when the user names one that does not exist.
 */

const sessionId = Type.String({
  minLength: 1,
  maxLength: 256,
  description: "A real Session ID from SessionList. Never guess or invent one.",
});

export const sessionToolParameters: Record<string, Parameters<typeof Type.Object>[0]> = {
  SessionList: {
    query: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Case-insensitive substring of a session title. Omit to list every other Agent session.",
      }),
    ),
  },
  SessionSend: {
    sessionId,
    content: Type.String({
      minLength: 1,
      maxLength: 65_536,
      description: "The complete task or message for the target session. It cannot ask the user follow-up questions there.",
    }),
    kind: Type.Optional(
      Type.Union([Type.Literal("task"), Type.Literal("message")], {
        // Both kinds start the target Agent; the label only frames intent.
        description: "task hands over work the target should carry out (default); message frames it as a notice. Both start or queue the target turn and spend its model quota.",
      }),
    ),
    delivery: Type.Optional(
      Type.Union([Type.Literal("queue"), Type.Literal("now")], {
        // "now" is the queue's own "send now": the Host delivers the text into
        // the target's running turn and keeps it at the head of that session's
        // queue when the turn cannot take more input.
        description: "queue (default) starts the target turn after its current work finishes; now inserts the text into the target's running turn so it is read immediately, and moves it to the front of that session's queue when the turn cannot accept more input.",
      }),
    ),
    notifyOnCompletion: Type.Optional(
      Type.Boolean({
        description: "Send this session one durable completion notice when the target turn settles. Defaults to true.",
      }),
    ),
  },
  SessionCreate: {
    title: Type.String({
      minLength: 1,
      maxLength: 80,
      description: "Short title for the new session, as it will appear in the session list.",
    }),
  },
  // The steward's task card. Declared here so it follows the same lifecycle as
  // the session tools: Agent mode only, on demand through ToolSearch, and
  // refused in a Plan or Goal turn (ADR bot-sessions-and-steward §2).
  TaskCard: {
    action: Type.Union(
      [Type.Literal("propose"), Type.Literal("revise"), Type.Literal("confirm"), Type.Literal("drop")],
      {
        description:
          "propose shows a new card; revise changes a card nobody has confirmed; confirm freezes the card the person approved; drop withdraws a proposal.",
      },
    ),
    draftId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description: "The card handle returned by propose. Required for revise, confirm and drop.",
      }),
    ),
    draft: Type.Optional(
      Type.Object(
        {
          goal: Type.String({ minLength: 1, maxLength: 2_048 }),
          criteria: Type.Array(
            Type.Object({
              id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
              text: Type.String({ minLength: 1, maxLength: 500 }),
            }),
            { minItems: 1, maxItems: 12 },
          ),
          boundaries: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 12 })),
          repo: Type.Optional(
            Type.Object({
              origin: Type.String({ minLength: 1, maxLength: 512 }),
              ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            }),
          ),
          permissionMode: Type.Union([
            Type.Literal("auto"),
            Type.Literal("accept-edits"),
            Type.Literal("ask"),
          ]),
          mustAsk: Type.Optional(Type.Array(Type.String({ maxLength: 32 }))),
          risk: Type.Optional(
            Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
          ),
        },
        { description: "The card to propose or revise. Required for propose and revise." },
      ),
    ),
    sourceUtterance: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          "The person's own words for this request. Required for propose and confirm: it is what makes the frozen card reviewable.",
      }),
    ),
  },
  SessionResult: {
    sessionId,
    messageId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256, description: "A delivery ID from a previous SessionSend." }),
    ),
  },
};

export const sessionToolDescriptions: Record<string, string> = {
  SessionList:
    "List the other Agent sessions that can receive a delivery, optionally filtered by a title substring. Use it to turn a session name the user said into a real Session ID, and to confirm the target before sending. Titles are not unique: when several sessions match, ask the user which one instead of guessing. Only Agent-mode sessions appear.",
  TaskCard:
    "Propose, revise or drop one task card for an employee session. A card is what the person confirms before work is dispatched: goal, acceptance criteria, boundaries, repository, permission mode, and the actions that must come back to them. Use `action: \"propose\"` with `targetSessionId` to show a card, `\"revise\"` to change a card nobody has confirmed, and `\"drop\"` to withdraw one. You cannot confirm a card: the person confirms it in the app, and their click is what dispatches the work. A card asks for permission and never grants it — `permissionMode` is required, `inherit` is refused, and deploy/delete/spend are always added to `mustAsk`.",
  SessionSend:
    "Deliver a task or message to another existing Agent session, which starts (or queues behind its current work) and runs with the target's own project, model, context and permissions. Use it when the user asks to hand work to a session by name: resolve the name with SessionList first, then send to that Session ID. Choose `delivery: \"now\"` when the target must act on it inside its current turn instead of after that turn ends; the default queues it. The target receives this as a session message, not as user input, so it cannot ask the user follow-up questions; write a self-contained brief, and expect a durable completion notice in this session unless notifyOnCompletion is false. This tool cannot create a session: use SessionCreate first when no session exists yet. It cannot cancel another sender's delivery either.",
  SessionResult:
    "Read the durable outcome of the latest delivery this session made into a session, or of one such delivery by messageId: status, result, error and the task text. Use it after a SessionSend to check a delivery that has not completed, or when the completion notice is not enough. Deliveries sent by other sessions or plugins are not readable here.",
  SessionCreate:
    "Create a new Agent session, so work can be handed to a session that does not exist yet. Use it when the user names a target session and SessionList shows none, then deliver the task to the returned Session ID with SessionSend. The new session runs on the model configured in Settings > AI (session creation model) and inherits this session's project, thinking level and permission mode; while that setting is unset this tool refuses instead of spending the app default model. It creates the session only: it starts no turn, sends no task, and does not rename or reuse an existing session.",
};
