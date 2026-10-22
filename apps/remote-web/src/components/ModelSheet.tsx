/**
 * The model sheet (ADR mobile-direct-gateway-chat §3).
 *
 * The same list D3's composer chip opens: a search field, the models this client
 * can actually use, and the rest listed below with the reason they cannot be
 * chosen. Nothing here needs a Host or a provider row — the source is the model
 * gateway's own catalog — which is why the remote session sheets are untouched.
 *
 * Disabled rows are shown, not hidden: a user who is looking for a model they
 * know exists should find it and learn why it is unavailable, instead of
 * wondering whether the list is broken.
 */
import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MinihRouterModel } from "@minih-agent/shared";

import {
  filterDirectModels,
  splitDirectModels,
  type ModelUnavailableReason,
} from "../lib/direct-chat/catalog.js";
import { Sheet } from "../components/ui/Sheet.js";

export type ModelSheetProps = {
  open: boolean;
  models: readonly MinihRouterModel[];
  /** The model the conversation or account is on, if any. */
  selectedId: string | null;
  onClose: () => void;
  onSelect: (model: MinihRouterModel) => void;
};

export function ModelSheet({ open, models, selectedId, onClose, onSelect }: ModelSheetProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const { usable, disabled } = useMemo(() => splitDirectModels(filterDirectModels(models, query)), [models, query]);

  return (
    <Sheet open={open} onClose={onClose} title={t("modelSheet.title")}>
      <label className="mb-3 flex min-h-[40px] items-center gap-2 rounded-[10px] bg-[var(--rm-bg-inset)] px-3">
        <Search className="h-4 w-4 shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("modelSheet.search")}
          aria-label={t("modelSheet.search")}
          className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none"
        />
      </label>

      <div className="max-h-[52dvh] overflow-y-auto">
        {usable.length === 0 ? (
          <p className="px-1 py-6 text-center text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
            {models.length === 0 ? t("modelSheet.empty") : t("modelSheet.noMatch")}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--rm-separator)]">
            {usable.map(({ model, protocol }) => {
              const selected = model.id === selectedId;
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(model);
                      onClose();
                    }}
                    aria-current={selected ? "true" : undefined}
                    className="flex w-full items-center gap-3 px-1 py-3 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
                        {model.id}
                      </span>
                      <span className="block truncate text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                        {[model.vendor, protocolLabel(protocol)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {selected ? (
                      <Check className="h-4 w-4 shrink-0 text-[var(--rm-accent)]" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {disabled.length > 0 ? (
          <>
            <p className="px-1 pb-1 pt-4 text-[13px] font-normal leading-[18px] text-[var(--rm-text-muted)]">
              {t("modelSheet.unavailableSection")}
            </p>
            <ul className="divide-y divide-[var(--rm-separator)]">
              {disabled.map(({ model, reason }) => (
                <li
                  key={model.id}
                  className="flex items-center gap-3 px-1 py-3 opacity-60"
                  aria-disabled="true"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
                      {model.id}
                    </span>
                    <span className="block text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                      {reasonLabel(t, reason)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

function protocolLabel(protocol: string): string {
  if (protocol === "openai-completions") return "Chat Completions";
  if (protocol === "openai-responses") return "Responses";
  return protocol;
}

function reasonLabel(t: (key: string) => string, reason: ModelUnavailableReason): string {
  if (reason === "image-model") return t("modelSheet.reason.imageModel");
  return reason === "not-chat" ? t("modelSheet.reason.notChat") : t("modelSheet.reason.protocol");
}
