import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LearnedMemoryKind, LearnedMemoryScopeKind, UiMessage } from "@minih-agent/shared";
import { api } from "../../../lib/api";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { Button, Textarea } from "../../../components/ui";
import { IconCheck, IconSparkles, IconTrash } from "../../../components/icons";

type Receipt = {
  entry: {
    id: string;
    kind: LearnedMemoryKind;
    scope: LearnedMemoryScopeKind;
    content: string;
    rationale?: string | null;
    revision: number;
  };
  duplicate: boolean;
  note?: string;
};

/** The message a refused write carries, whichever layer reported it. */
function refusalCode(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** A stored entry, or nothing when the row is not a saved receipt. */
function receiptOf(payload: unknown): Receipt | null {
  if (!payload || typeof payload !== "object") return null;
  const entry = (payload as { entry?: unknown }).entry;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.content !== "string") return null;
  if (typeof record.revision !== "number") return null;
  return payload as Receipt;
}

/**
 * The `MemoryRemember` receipt (ADR agent-long-term-memory §3.1).
 *
 * A saved note is something the user keeps, so the row carries the text, the
 * scope it applies to, and the two actions that matter: edit the wording, or
 * undo the save. Undo is a real delete — the host writes the tombstone — so the
 * row says so rather than pretending it can be toggled back.
 */
export function MemoryRememberReceipt({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  const payload = toolResultPayload(message);
  const receipt = receiptOf(payload);
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<Receipt | null>(receipt);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [failed, setFailed] = useState("");

  const refused = message.toolStatus === "error" || message.toolStatus === "denied";
  if (refused) {
    const code = refusalCode(payload);
    const reasonKey = `memory.reason.${code}`;
    const reason = code && t(reasonKey) !== reasonKey ? t(reasonKey) : t("memory.reason.INTERNAL");
    return (
      <div className="learned-memory-receipt learned-memory-receipt-refused" role="note">
        <span className="learned-memory-receipt-head">
          <IconSparkles size={14} aria-hidden />
          {t("memory.rememberSaved")}
        </span>
        <p className="learned-memory-receipt-refusal">
          {t("memory.rememberRefused", { reason })}
        </p>
      </div>
    );
  }

  const current = saved ?? receipt;
  if (!current) return null;

  const save = async () => {
    if (draft === null || !draft.trim()) return;
    setBusy(true);
    setFailed("");
    try {
      const result = await api.updateLearnedMemory({
        id: current.entry.id,
        revision: current.entry.revision,
        content: draft.trim(),
      });
      setSaved({
        ...current,
        entry: {
          ...current.entry,
          content: result.entry.content,
          revision: result.entry.revision,
        },
      });
      setDraft(null);
    } catch (error) {
      const code = (error as { errorCode?: unknown })?.errorCode;
      setFailed(typeof code === "string" ? `memory.reason.${code}` : "memory.reason.INTERNAL");
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    setBusy(true);
    setFailed("");
    try {
      await api.deleteLearnedMemory(current.entry.id);
      setDeleted(true);
    } catch {
      setFailed("memory.reason.INTERNAL");
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel =
    current.entry.scope === "user" ? t("memory.rememberScopeUser") : t("memory.rememberScopeProject");

  return (
    <div className="learned-memory-receipt" role="note" data-memory-entry={current.entry.id}>
      <div className="learned-memory-receipt-head">
        <IconSparkles size={14} aria-hidden />
        <span>{current.duplicate ? t("memory.rememberDuplicate") : t("memory.rememberSaved")}</span>
        <span className="learned-memory-receipt-scope">{scopeLabel}</span>
        <span className="learned-memory-kind">{t(`memory.kind.${current.entry.kind}`)}</span>
      </div>
      {deleted ? (
        <p className="learned-memory-receipt-deleted">{t("memory.rememberUndone")}</p>
      ) : draft !== null ? (
        <>
          <Textarea
            className="learned-memory-receipt-editor"
            value={draft}
            aria-label={t("memory.editContent")}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="learned-memory-receipt-actions">
            <Button type="button" size="sm" disabled={busy || !draft.trim()} onClick={() => void save()}>
              <IconCheck size={13} aria-hidden />
              {t("memory.saveEdit")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              {t("settings.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="learned-memory-receipt-content">{current.entry.content}</p>
          <p className="learned-memory-receipt-note">{t("memory.rememberNote")}</p>
          <div className="learned-memory-receipt-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(current.entry.content)}
            >
              {t("memory.edit")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>
              <IconTrash size={13} aria-hidden />
              {busy ? t("memory.rememberUndoing") : t("memory.rememberUndo")}
            </Button>
          </div>
        </>
      )}
      {failed ? <p className="learned-memory-receipt-refusal">{t(failed)}</p> : null}
    </div>
  );
}
