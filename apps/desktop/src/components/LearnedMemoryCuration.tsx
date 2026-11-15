/**
 * "Recently curated": what the automatic pass changed, and the undo
 * (ADR learned-memory-consolidation §3).
 *
 * It is collapsed by default and its title carries the count, so a user who
 * never opens it is still told that memory is being tidied. Every row is a
 * recorded change with its reason, and the undo is one button: the host
 * re-checks the note against the snapshot it wrote, so an undo that cannot be
 * applied safely says so instead of guessing.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LearnedMemoryCurationListResult,
  LearnedMemoryRevision,
  LearnedMemoryScopeKind,
} from "@minih-agent/shared";
import { api } from "../lib/api";
import { curationTitle, groupCurationBatches, undoConflict } from "../lib/learned-memory-curation";
import { Button } from "./ui";

export function MemoryCurationList({
  scope,
  projectPath,
  busy,
  onBusyChange,
  onError,
  onChanged,
}: {
  scope: LearnedMemoryScopeKind;
  projectPath?: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onError: (error: unknown) => void;
  /** The list changed something, so the notes above need a reload. */
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  // Reading the list is what the block is for, so it opens collapsed and loads
  // on the first expansion: a user who never cares pays nothing.
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<LearnedMemoryCurationListResult | null>(null);
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.listMemoryCuration({
        scope,
        ...(scope === "project" && projectPath ? { path: projectPath } : {}),
      });
      setData(result);
    } catch {
      // The block is context, not a control: a failed read hides it.
      setData(null);
    }
  }, [projectPath, scope]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const changeCount = data?.changes ?? 0;
  const title = t(curationTitle(changeCount), { count: changeCount });

  const undo = (batchId: string) => {
    onBusyChange(true);
    void (async () => {
      setConflict(false);
      try {
        await api.undoMemoryCuration(batchId);
        await load();
        onChanged();
      } catch (error) {
        if (undoConflict(error)) {
          // The note changed after the pass; the undo changed nothing.
          setConflict(true);
          await load();
        } else {
          onError(error);
        }
      } finally {
        onBusyChange(false);
      }
    })();
  };

  const batches = groupCurationBatches(data?.records ?? []);

  return (
    <section className="learned-memory-curation" aria-label={title}>
      <button
        type="button"
        className="learned-memory-curation-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="learned-memory-curation-title">{title}</span>
        <span className="learned-memory-curation-arrow" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="learned-memory-curation-body">
          {conflict ? (
            <p className="learned-memory-conflict" role="alert">
              {t("memory.curationConflict")}
            </p>
          ) : null}
          {batches.length === 0 ? (
            <p className="learned-memory-curation-empty">{t("memory.curationEmpty")}</p>
          ) : (
            <ul className="learned-memory-curation-batches">
              {batches.map((batch) => (
                <li key={batch.batchId} className="learned-memory-curation-batch">
                  <div className="learned-memory-curation-batch-head">
                    <span className="learned-memory-curation-op">
                      {t(`memory.curationOp.${batch.kind}`)}
                    </span>
                    <time
                      className="learned-memory-curation-time"
                      dateTime={new Date(batch.createdAt).toISOString()}
                    >
                      {new Date(batch.createdAt).toLocaleString(i18n.language, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="learned-memory-curation-undo"
                      disabled={busy}
                      onClick={() => undo(batch.batchId)}
                    >
                      {t("memory.curationUndo")}
                    </Button>
                  </div>
                  <ul className="learned-memory-curation-rows">
                    {batch.rows.map((row) => (
                      <CurationRow key={row.id} row={row} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function CurationRow({ row }: { row: LearnedMemoryRevision }) {
  const { t } = useTranslation();
  return (
    <li className="learned-memory-curation-row">
      <div className="learned-memory-curation-before">
        {row.before ? <s>{oneLine(row.before.content)}</s> : null}
      </div>
      <div className="learned-memory-curation-after">{oneLine(row.after.content)}</div>
      {row.reason ? (
        <div className="learned-memory-curation-reason">
          {t("memory.curationReason", { reason: row.reason })}
        </div>
      ) : null}
    </li>
  );
}

/** One record on one line, so a long note cannot restyle the list. */
function oneLine(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}
