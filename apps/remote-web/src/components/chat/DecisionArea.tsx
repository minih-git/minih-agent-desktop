import type {
  RacpApprovalDecision,
  RacpApprovalRequest,
  RacpInputRequest,
} from "@minih-agent/shared";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  HelpCircle,
  Shield,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ResponseAttempt } from "../../hooks/useSessionScreen.js";
import { createIdempotencyKey, createRequestId } from "../../lib/ids.js";
import {
  answersPayload,
  initialAnswers,
  isAnswered,
  isSkipped,
  selectedFor,
  toggleOption,
  toggleSkip,
  type InputAnswers,
} from "../../lib/input-answers.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/StatusDot.js";
import { ConfirmHighRiskSheet } from "./ConfirmHighRiskSheet.js";

const SESSION_GRANT: RacpApprovalDecision = "allow-session";

export interface DecisionAreaProps {
  approvals: RacpApprovalRequest[];
  inputs: RacpInputRequest[];
  pending: Record<string, boolean>;
  hostLabel: string;
  onDecideApproval: (
    approvalId: string,
    decision: RacpApprovalDecision,
    attempt: ResponseAttempt,
  ) => void;
  onSubmitInput: (
    inputId: string,
    answers: Array<string[] | null>,
    attempt: ResponseAttempt,
  ) => void;
}

export function DecisionArea({
  approvals,
  inputs,
  pending,
  hostLabel,
  onDecideApproval,
  onSubmitInput,
}: DecisionAreaProps) {
  const { t } = useTranslation();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [highRiskTarget, setHighRiskTarget] = useState<{
    id: string;
    decision: RacpApprovalDecision;
    attempt: ResponseAttempt;
  } | null>(null);

  // Combined list of decision items
  const items = [
    ...approvals.map((req) => ({ kind: "approval" as const, data: req })),
    ...inputs.map((req) => ({ kind: "input" as const, data: req })),
  ];

  const total = items.length;
  if (total === 0) return null;

  const safeIndex = Math.min(currentIndex, total - 1);
  const activeItem = items[safeIndex]!;

  return (
    <>
      <section
        role="region"
        aria-label={t("session.turn.waiting_approval")}
        className="my-1.5 flex max-h-[clamp(200px,100dvh-400px,55dvh)] flex-col overflow-hidden rounded-[20px] border-[1.5px] border-transparent [background:linear-gradient(var(--rm-bg-solid),var(--rm-bg-solid))_padding-box,linear-gradient(135deg,var(--rm-decision),var(--rm-accent-2))_border-box] shadow-[0_0_0_6px_color-mix(in_srgb,var(--rm-decision)_10%,transparent)] [animation:rm-decision-glow_2.4s_ease-in-out_infinite]"
      >
        {/* Header with Title and Pager */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--rm-hair)] px-4">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--rm-decision)]">
            {activeItem.kind === "approval" ? (
              <Shield className="h-4 w-4" aria-hidden="true" />
            ) : (
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
            )}
            <span>
              {activeItem.kind === "approval" ? t("approval.title") : t("input.title")}
            </span>
          </div>

          {total > 1 ? (
            <div className="flex items-center gap-1 text-[12px] font-medium text-[var(--rm-text-muted)]">
              <button
                type="button"
                disabled={safeIndex === 0}
                onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
                className="flex h-7 w-7 items-center justify-center rounded-[6px] active:opacity-60 disabled:opacity-30"
                aria-label={t("approval.previousDecision")}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span>
                {safeIndex + 1}/{total}
              </span>
              <button
                type="button"
                disabled={safeIndex === total - 1}
                onClick={() => setCurrentIndex((prev) => Math.min(total - 1, prev + 1))}
                className="flex h-7 w-7 items-center justify-center rounded-[6px] active:opacity-60 disabled:opacity-30"
                aria-label={t("approval.nextDecision")}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {activeItem.kind === "approval" ? (
            <ApprovalBody
              request={activeItem.data}
              isPending={pending[`approval:${activeItem.data.id}`] === true}
              onDecide={(decision, attempt) => {
                if (
                  activeItem.data.risk === "high" &&
                  (decision === "allow-once" || decision === "approve")
                ) {
                  setHighRiskTarget({ id: activeItem.data.id, decision, attempt });
                } else {
                  onDecideApproval(activeItem.data.id, decision, attempt);
                }
              }}
            />
          ) : (
            <InputBody
              // A new request is a new set of questions: without this key React
              // reuses the previous body, so the selection carried over into the
              // next request and `selected[i]!` could throw when that request had
              // more questions than the previous one.
              key={activeItem.data.id}
              request={activeItem.data}
              isPending={pending[`input:${activeItem.data.id}`] === true}
              onSubmit={(answers, attempt) => {
                onSubmitInput(activeItem.data.id, answers, attempt);
              }}
            />
          )}
        </div>
      </section>

      <ConfirmHighRiskSheet
        open={Boolean(highRiskTarget)}
        hostLabel={hostLabel}
        onClose={() => setHighRiskTarget(null)}
        onConfirm={() => {
          if (highRiskTarget) {
            onDecideApproval(
              highRiskTarget.id,
              highRiskTarget.decision,
              highRiskTarget.attempt,
            );
            setHighRiskTarget(null);
          }
        }}
      />
    </>
  );
}

function ApprovalBody({
  request,
  isPending,
  onDecide,
}: {
  request: RacpApprovalRequest;
  isPending: boolean;
  onDecide: (decision: RacpApprovalDecision, attempt: ResponseAttempt) => void;
}) {
  const { t, i18n } = useTranslation();
  const attempts = useRef(new Map<string, ResponseAttempt>());

  const attemptFor = (decision: string): ResponseAttempt => {
    const existing = attempts.current.get(decision);
    if (existing) return existing;
    const created = { idempotencyKey: createIdempotencyKey(), requestId: createRequestId() };
    attempts.current.set(decision, created);
    return created;
  };

  const decisions = request.allowedDecisions.filter((decision) => decision !== SESSION_GRANT);

  return (
    <div className="space-y-3">
      {/* Risk and Tool Tags */}
      <div className="flex flex-wrap items-center gap-2">
        {request.risk ? (
          <Chip
            tone={
              request.risk === "high"
                ? "error"
                : request.risk === "medium"
                  ? "running"
                  : "neutral"
            }
          >
            {t(`approval.risk.${request.risk}`)}
          </Chip>
        ) : null}
        {request.toolName ? (
          <span className="font-mono text-[12px] font-medium text-[var(--rm-text-secondary)]">
            {request.toolName}
          </span>
        ) : null}
      </div>

      {/* Command / Action Summary */}
      <div className="rounded-[10px] bg-[var(--rm-code-bg)] p-2.5 font-mono text-[13px] leading-[18px] text-[var(--rm-text-primary)] break-all">
        {request.summary}
      </div>

      {/* High-risk Warning Callout */}
      {request.risk === "high" ? (
        <div className="flex items-start gap-2 rounded-[10px] bg-[color-mix(in_srgb,var(--rm-error)_12%,transparent)] p-2.5 text-[12px] leading-[16px] text-[var(--rm-error)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("approval.highRiskWarn")}</span>
        </div>
      ) : null}

      {/* Expires indicator */}
      <div className="flex items-center gap-1.5 text-[12px] text-[var(--rm-text-muted)]">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          {t("approval.expiresAt", {
            time: new Date(request.expiresAt).toLocaleTimeString(i18n.language),
          })}
        </span>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 pt-1">
        {decisions.map((decision) => {
          const isDeny = decision === "deny" || decision === "reject";
          return (
            <Button
              key={decision}
              variant={isDeny ? "destructive" : "primary"}
              size="medium"
              disabled={isPending}
              aria-label={`${t("approval.title")}: ${t(`approval.decision.${decision}`)}`}
              className="flex-1"
              onClick={() => onDecide(decision, attemptFor(decision))}
            >
              {isPending ? t("approval.responding") : t(`approval.decision.${decision}`)}
            </Button>
          );
        })}
      </div>

      {request.allowedDecisions.includes(SESSION_GRANT) ? (
        <p className="pt-1 text-center text-[12px] text-[var(--rm-text-muted)]">
          {t("approval.sessionGrantDesktopOnly")}
        </p>
      ) : null}
    </div>
  );
}

function InputBody({
  request,
  isPending,
  onSubmit,
}: {
  request: RacpInputRequest;
  isPending: boolean;
  onSubmit: (answers: Array<string[] | null>, attempt: ResponseAttempt) => void;
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<InputAnswers>(() =>
    initialAnswers(request.questions.length),
  );
  const attempts = useRef(new Map<string, ResponseAttempt>());

  const toggle = (qIdx: number, opt: string, multi: boolean) => {
    setAnswers((prev) => toggleOption(prev, qIdx, opt, multi));
  };

  const skip = (qIdx: number) => {
    setAnswers((prev) => toggleSkip(prev, qIdx));
  };

  const payload = answersPayload(answers);
  const ready = isAnswered(answers);

  const handleSubmit = () => {
    const sig = JSON.stringify(payload);
    let attempt = attempts.current.get(sig);
    if (!attempt) {
      attempt = { idempotencyKey: createIdempotencyKey(), requestId: createRequestId() };
      attempts.current.set(sig, attempt);
    }
    onSubmit(payload, attempt);
  };

  return (
    <div className="space-y-4" data-request-id={request.id}>
      {request.questions.map((q, qIdx) => (
        <div key={q.id || qIdx} className="space-y-2">
          {request.questions.length > 1 ? (
            <div className="text-[12px] font-medium text-[var(--rm-text-muted)]">
              {t("input.questionProgress", {
                current: qIdx + 1,
                total: request.questions.length,
              })}
            </div>
          ) : null}

          <div className="text-[14px] font-medium leading-[20px] text-[var(--rm-text-primary)]">
            {q.question}
          </div>

          {q.multiSelect ? (
            <div className="text-[12px] text-[var(--rm-text-muted)]">
              {t("input.multiSelect")}
            </div>
          ) : null}

          <div className="space-y-1.5" role={q.multiSelect ? "group" : "radiogroup"}>
            {q.options.map((opt) => {
              const isChecked = selectedFor(answers, qIdx).includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={isChecked}
                  onClick={() => toggle(qIdx, opt, q.multiSelect)}
                  className={`flex w-full items-center gap-3 rounded-[10px] p-2.5 text-left text-[14px] font-medium transition-colors ${
                    isChecked
                      ? "bg-[color-mix(in_srgb,var(--rm-decision)_15%,var(--rm-bg-surface))] text-[var(--rm-text-primary)] shadow-[inset_0_0_0_1.5px_var(--rm-decision)]"
                      : "bg-[var(--rm-bg-surface)] text-[var(--rm-text-primary)] shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center border text-[var(--rm-bg-page)] transition-colors ${
                      q.multiSelect ? "rounded-[4px]" : "rounded-full"
                    } ${
                      isChecked
                        ? "border-[var(--rm-decision)] bg-[var(--rm-decision)]"
                        : "border-[var(--rm-text-muted)] bg-transparent"
                    }`}
                  >
                    {isChecked ? <Check className="h-3 w-3 stroke-[3]" /> : null}
                  </span>
                  <span className="flex-1">{opt}</span>
                </button>
              );
            })}
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => skip(qIdx)}
              className="text-[12px] font-medium text-[var(--rm-text-muted)] hover:underline active:opacity-60"
            >
              {isSkipped(answers, qIdx) ? t("common.cancel") : t("input.skip")}
            </button>
          </div>
        </div>
      ))}

      <div className="pt-2">
        <Button
          variant="primary"
          size="medium"
          disabled={isPending || !ready}
          onClick={handleSubmit}
          className="w-full"
        >
          {isPending ? t("input.sending") : t("input.submit")}
        </Button>
      </div>
    </div>
  );
}
