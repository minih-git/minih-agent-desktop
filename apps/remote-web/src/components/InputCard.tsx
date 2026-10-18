/**
 * Input (asktool) card (PR-4).
 *
 * RACP publishes one question per entry with plain label options, so every
 * question the Host sends is answerable here. A question with no options is
 * the one shape this client cannot express — the card says so instead of
 * submitting an empty answer.
 */
import type { RacpInputRequest } from "@minih-agent/shared";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ResponseAttempt } from "../hooks/useSessionScreen.js";
import { createIdempotencyKey, createRequestId } from "../lib/ids.js";
import { Button, Card } from "./Chrome.js";

function isAnswerable(request: RacpInputRequest): boolean {
  return request.questions.every((question) => question.options.length > 0);
}

export function InputCard({
  request,
  pending,
  onSubmit,
}: {
  request: RacpInputRequest;
  pending: boolean;
  onSubmit: (answers: Array<string[] | null>, attempt: ResponseAttempt) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []));
  const [skipped, setSkipped] = useState<boolean[]>(() => request.questions.map(() => false));
  const attempts = useRef(new Map<string, ResponseAttempt>());

  const toggle = (questionIndex: number, option: string, multiSelect: boolean): void => {
    setSelected((current) =>
      current.map((answer, index) => {
        if (index !== questionIndex) return answer;
        if (multiSelect) {
          return answer.includes(option) ? answer.filter((value) => value !== option) : [...answer, option];
        }
        return [option];
      }),
    );
    setSkipped((current) => current.map((value, index) => (index === questionIndex ? false : value)));
  };

  const answers: Array<string[] | null> = selected.map((answer, index) =>
    skipped[index] ? null : answer.length > 0 ? answer : null,
  );
  const ready = request.questions.every((_, index) => skipped[index] || selected[index]!.length > 0);

  const submit = (): void => {
    const signature = JSON.stringify(answers);
    let attempt = attempts.current.get(signature);
    if (!attempt) {
      attempt = { idempotencyKey: createIdempotencyKey(), requestId: createRequestId() };
      attempts.current.set(signature, attempt);
    }
    onSubmit(answers, attempt);
  };

  return (
    <Card className="border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40">
      <h2 className="mb-2 text-sm font-semibold">{t("input.title")}</h2>
      {isAnswerable(request) ? (
        <>
          <ol className="flex flex-col gap-3">
            {request.questions.map((question, questionIndex) => (
              <li key={question.id}>
                <p className="whitespace-pre-wrap break-words text-sm">{question.question}</p>
                <p className="mb-2 text-xs text-slate-600 dark:text-slate-300">
                  {question.multiSelect ? t("input.multiSelect") : null}
                </p>
                <div className="flex flex-wrap gap-2">
                  {question.options.map((option) => {
                    const chosen = selected[questionIndex]!.includes(option);
                    return (
                      <Button
                        key={option}
                        variant={chosen ? "primary" : "secondary"}
                        aria-pressed={chosen}
                        aria-label={`${question.question}: ${option}`}
                        disabled={pending}
                        onClick={() => toggle(questionIndex, option, question.multiSelect)}
                      >
                        {option}
                      </Button>
                    );
                  })}
                  <Button
                    variant="ghost"
                    disabled={pending}
                    aria-pressed={skipped[questionIndex] === true}
                    onClick={() =>
                      setSkipped((current) => current.map((value, index) => (index === questionIndex ? !value : value)))
                    }
                  >
                    {t("input.skip")}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3">
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              {pending ? t("input.sending") : t("input.submit")}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm">{t("input.askOnDesktop")}</p>
      )}
    </Card>
  );
}
