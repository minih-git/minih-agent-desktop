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
  SessionSend:
    "Deliver a task or message to another existing Agent session, which starts (or queues behind its current work) and runs with the target's own project, model, context and permissions. Use it when the user asks to hand work to a session by name: resolve the name with SessionList first, then send to that Session ID. Choose `delivery: \"now\"` when the target must act on it inside its current turn instead of after that turn ends; the default queues it. The target receives this as a session message, not as user input, so it cannot ask the user follow-up questions; write a self-contained brief, and expect a durable completion notice in this session unless notifyOnCompletion is false. This tool cannot create a session: use SessionCreate first when no session exists yet. It cannot cancel another sender's delivery either.",
  SessionResult:
    "Read the durable outcome of the latest delivery this session made into a session, or of one such delivery by messageId: status, result, error and the task text. Use it after a SessionSend to check a delivery that has not completed, or when the completion notice is not enough. Deliveries sent by other sessions or plugins are not readable here.",
  SessionCreate:
    "Create a new Agent session, so work can be handed to a session that does not exist yet. Use it when the user names a target session and SessionList shows none, then deliver the task to the returned Session ID with SessionSend. The new session runs on the model configured in Settings > AI (session creation model) and inherits this session's project, thinking level and permission mode; while that setting is unset this tool refuses instead of spending the app default model. It creates the session only: it starts no turn, sends no task, and does not rename or reuse an existing session.",
};
