/**
 * Approval card (PR-4).
 *
 * Only the decisions the request itself offers are rendered, and
 * `allow-session` is never one of them: a gateway-paired device cannot grant a
 * session-wide permission (security §3.7), so offering the button would only
 * produce a refusal. The desktop remains the place for that decision.
 */
import type { RacpApprovalDecision, RacpApprovalRequest } from "@minih-agent/shared";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { createIdempotencyKey, createRequestId } from "../lib/ids.js";
import type { ResponseAttempt } from "../hooks/useSessionScreen.js";
import { Button, Card, Pill } from "./Chrome.js";

const SESSION_GRANT: RacpApprovalDecision = "allow-session";

export function ApprovalCard({
  request,
  pending,
  onDecide,
}: {
  request: RacpApprovalRequest;
  pending: boolean;
  onDecide: (decision: RacpApprovalDecision, attempt: ResponseAttempt) => void;
}) {
  const { t, i18n } = useTranslation();
  // One attempt per decision: tapping the same button again after a failure
  // reuses its key, while a different decision is a different user action.
  const attempts = useRef(new Map<string, ResponseAttempt>());

  const attemptFor = (decision: string): ResponseAttempt => {
    const existing = attempts.current.get(decision);
    if (existing) return existing;
    const created = { idempotencyKey: createIdempotencyKey(), requestId: createRequestId() };
    attempts.current.set(decision, created);
    return created;
  };

  const decisions = request.allowedDecisions.filter((decision) => decision !== SESSION_GRANT);
  const titleKey = request.kind === "tool" ? "approval.title" : request.kind === "plan" ? "approval.plan" : "approval.goal";

  return (
    <Card className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{t(titleKey)}</h2>
        {request.risk ? <Pill tone={request.risk === "high" ? "bad" : request.risk === "medium" ? "warn" : "neutral"}>{t(`approval.risk.${request.risk}`)}</Pill> : null}
        {request.toolName ? <span className="app-mono text-xs">{request.toolName}</span> : null}
      </header>
      <p className="whitespace-pre-wrap break-words text-sm">{request.summary}</p>
      {request.agentName ? (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{t("timeline.agent", { agent: request.agentName })}</p>
      ) : null}
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        {t("approval.expiresAt", { time: new Date(request.expiresAt).toLocaleTimeString(i18n.language) })}
      </p>
      {decisions.length === 0 ? (
        <p className="mt-2 text-sm">{t("approval.noDecisions")}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {decisions.map((decision) => (
            <Button
              key={decision}
              variant={decision === "deny" || decision === "reject" ? "danger" : "primary"}
              disabled={pending}
              aria-label={`${t("approval.title")}: ${t(`approval.decision.${decision}`)}`}
              onClick={() => onDecide(decision, attemptFor(decision))}
            >
              {pending ? t("approval.responding") : t(`approval.decision.${decision}`)}
            </Button>
          ))}
        </div>
      )}
      {request.allowedDecisions.includes(SESSION_GRANT) ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{t("approval.sessionGrant")}</p>
      ) : null}
    </Card>
  );
}
