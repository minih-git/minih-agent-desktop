import { ChevronDown, ChevronRight, ChevronUp, Laptop, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useHostStatus } from "../../hooks/useHostStatus.js";
import {
  formatHostStatusHelp,
  formatHostStatusLine,
  hostDotStatus,
  hostStatusAction,
  type HostDisplayStatusKind,
} from "../../lib/host-display.js";
import type { HostRegistryEntry } from "../../lib/host-registry.js";
import { credentialPort } from "../../lib/runtime.js";
import { Button } from "../ui/Button.js";
import { StatusDot } from "../ui/StatusDot.js";

export interface HostRowProps {
  entry: HostRegistryEntry;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onOpen: () => void;
  onOpenMore: (statusKind: HostDisplayStatusKind, refresh: () => void) => void;
  onAskAgain: () => void;
  onForgetAndPair: () => void;
}

export function HostRow({
  entry,
  isExpanded,
  onToggleExpand,
  onOpen,
  onOpenMore,
  onAskAgain,
  onForgetAndPair,
}: HostRowProps) {
  const { t } = useTranslation();
  const credential = credentialPort.credentialFor(entry.hostId);
  const { status, refresh } = useHostStatus(entry.hostId, credential);

  const isOnline = status.kind === "online";
  const dotStatus = hostDotStatus(status);
  const statusLine = formatHostStatusLine(status, t);
  const helpText = formatHostStatusHelp(status, entry, t);
  const action = hostStatusAction(status, entry);

  const handleRowClick = () => {
    if (isOnline) {
      onOpen();
    } else {
      onToggleExpand();
    }
  };

  const handleFixAction = () => {
    if (action.action === "refresh") {
      void refresh();
    } else if (action.action === "askAgain") {
      onAskAgain();
    } else if (action.action === "forgetAndPair") {
      onForgetAndPair();
    }
  };

  return (
    <div className="relative overflow-hidden bg-[var(--rm-bg-surface)] transition-colors">
      <div className="flex min-h-[56px] items-center gap-3 px-4 py-3">
        {/* Main tappable host info */}
        <button
          type="button"
          onClick={handleRowClick}
          className="flex min-w-0 flex-1 items-center gap-3 text-left active:opacity-70"
          aria-label={`${entry.label}，${statusLine}`}
        >
          <span className="sr-only">Open </span>
          {/* Laptop icon with status dot badge */}
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]">
            <Laptop className="h-4 w-4" aria-hidden="true" />
            <span className="absolute -bottom-0.5 -right-0.5">
              <StatusDot status={dotStatus} size="small" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold leading-[20px] text-[var(--rm-text-primary)]">
              {entry.label}
            </div>
            <div
              className={`truncate text-[13px] leading-[18px] ${
                status.kind === "revoked"
                  ? "text-[var(--rm-error)] font-medium"
                  : "text-[var(--rm-text-secondary)]"
              }`}
            >
              {statusLine}
            </div>
          </div>

          <div className="flex items-center text-[var(--rm-text-muted)]">
            {isOnline ? (
              <ChevronRight className="h-4 w-4 stroke-[2]" aria-hidden="true" />
            ) : isExpanded ? (
              <ChevronUp className="h-4 w-4 stroke-[2]" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4 stroke-[2]" aria-hidden="true" />
            )}
          </div>
        </button>

        {/* Action sheet trigger */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMore(status.kind, refresh);
          }}
          aria-label={`${entry.label} 的更多操作`}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-[var(--rm-text-muted)] transition-opacity active:opacity-60"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* Inline expansion for non-online states */}
      {!isOnline && isExpanded && helpText ? (
        <div className="border-t border-[var(--rm-separator)] bg-[var(--rm-bg-inset)] px-4 py-3">
          <p className="mb-3 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
            {helpText}
          </p>
          {action.action !== "none" ? (
            <Button
              variant={action.action === "forgetAndPair" ? "destructive" : "secondary"}
              size="small"
              onClick={handleFixAction}
            >
              {t(action.labelKey)}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
