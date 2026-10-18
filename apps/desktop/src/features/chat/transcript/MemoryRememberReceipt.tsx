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

/** The identity a tombstone refusal carries: the turn the receipt belongs to. */
function provenanceOf(payload: unknown): { sessionId: string; turnId: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { sessionId?: unknown; turnId?: unknown };
  if (typeof record.sessionId !== "string" || typeof record.turnId !== "string") return null;
  if (!record.sessionId || !record.turnId) return null;
  return { sessionId: record.sessionId, turnId: record.turnId };
}

/**
 * What the model asked to store. The "remember again" button repeats exactly
 * this request: the renderer never composes a note of its own.
 */
function restoreDraftOf(message: UiMessage): {
  content: string;
  kind: LearnedMemoryKind;
  scope?: LearnedMemoryScopeKind;
  basis?: "user_stated" | "verified";
  rationale?: string;
} | null {
  const args = message.toolArgs;
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (typeof record.content !== "string" || !record.content.trim()) return null;
  const kind = record.kind;
  if (kind !== "preference" && kind !== "feedback" && kind !== "fact" && kind !== "reference") {
    return null;
  }
  const scope = record.scope === "user" || record.scope === "project" ? record.scope : undefined;
  const basis =
    record.basis === "verified" || record.basis === "user_stated" ? record.basis : undefined;
  const rationale = typeof record.rationale === "string" ? record.rationale : undefined;
  return {
    content: record.content.trim(),
    kind,
    ...(scope ? { scope } : {}),
    ...(basis ? { basis } : {}),
    ...(rationale ? { rationale } : {}),
  };
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
  const [restoring, setRestoring] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState("");
  const [restoredId, setRestoredId] = useState<string | null>(null);
  // What the model asked to store, so the user's own "remember again" sends the
  // same note rather than a summary the renderer invented.
  const restoreDraft = restoreDraftOf(message);

  const rememberAgain = async (provenance: { sessionId: string; turnId: string }) => {
    if (!restoreDraft) return;
    setRestoring(true);
    setRestoreFailed("");
    try {
      const result = await api.rememberLearnedMemoryAgain({
        sessionId: provenance.sessionId,
        turnId: provenance.turnId,
        kind: restoreDraft.kind,
        content: restoreDraft.content,
        ...(restoreDraft.scope ? { scope: restoreDraft.scope } : {}),
        ...(restoreDraft.basis ? { basis: restoreDraft.basis } : {}),
        ...(restoreDraft.rationale ? { rationale: restoreDraft.rationale } : {}),
      });
      if (result.rejected) {
        setRestoreFailed(`memory.reason.${result.rejected.code}`);
        return;
      }
      if (result.entry) setRestoredId(result.entry.id);
    } catch (error) {
      const code = (error as { errorCode?: unknown })?.errorCode;
      setRestoreFailed(typeof code === "string" ? `memory.reason.${code}` : "memory.reason.INTERNAL");
    } finally {
      setRestoring(false);
    }
  };

  const refused = message.toolStatus === "error" || message.toolStatus === "denied";
  if (refused && restoredId) {
    return (
      <div className="learned-memory-receipt" role="note" data-memory-entry={restoredId}>
        <div className="learned-memory-receipt-head">
          <IconSparkles size={14} aria-hidden />
          <span>{t("memory.rememberSaved")}</span>
          <span className="learned-memory-receipt-scope">
            {restoreDraft?.scope === "user"
              ? t("memory.rememberScopeUser")
              : t("memory.rememberScopeProject")}
          </span>
        </div>
        <p className="learned-memory-receipt-content">{restoreDraft?.content ?? ""}</p>
        <p className="learned-memory-receipt-note">{t("memory.rememberNote")}</p>
      </div>
    );
  }
  if (refused) {
    const code = refusalCode(payload);
    const reasonKey = `memory.reason.${code}`;
    const reason = code && t(reasonKey) !== reasonKey ? t(reasonKey) : t("memory.reason.INTERNAL");
    // A tombstone is the one refusal the user can overrule, and only here: the
    // model may never bring the note back, so the button is the whole point of
    // the refusal (ADR §6).
    const provenance = code === "MEMORY_TOMBSTONED" ? provenanceOf(payload) : null;
    return (
      <div className="learned-memory-receipt learned-memory-receipt-refused" role="note">
        <span className="learned-memory-receipt-head">
          <IconSparkles size={14} aria-hidden />
          {t("memory.rememberSaved")}
        </span>
        <p className="learned-memory-receipt-refusal">
          {t("memory.rememberRefused", { reason })}
        </p>
        {provenance && restoreDraft ? (
          <div className="learned-memory-receipt-actions">
            <Button
              type="button"
              size="sm"
              disabled={restoring}
              onClick={() => void rememberAgain(provenance)}
            >
              <IconCheck size={13} aria-hidden />
              {restoring ? t("memory.rememberAgainBusy") : t("memory.rememberAgain")}
            </Button>
          </div>
        ) : null}
        {restoreFailed ? (
          <p className="learned-memory-receipt-refusal">{t(restoreFailed)}</p>
        ) : null}
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
