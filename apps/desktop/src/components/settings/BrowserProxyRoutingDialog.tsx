/** Auto-saving editor for the existing browser routing table (ADR 0342). */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AppSettings, BrowserProxyRouting, BrowserProxyRoutingIssue, BrowserProxyRuleKind } from "@minih-agent/shared";
import {
  BROWSER_PROXY_DIRECT, BROWSER_PROXY_RULE_KINDS, browserProxyRequestForUrl,
  matchBrowserProxyRoute, moveBrowserProxyRule, removeBrowserProxyProfile,
  validateBrowserProxyRouting,
} from "@minih-agent/shared";
import { Button, HelpIcon, Input, OverlayBackdrop, SegmentedControl, TooltipButton } from "../ui";
import { IconClose } from "../icons";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { useAppStore } from "../../stores/app-store";

const KIND_LABEL_KEY: Record<BrowserProxyRuleKind, string> = {
  "host-wildcard": "settings.browserProxyKindHostWildcard",
  "url-wildcard": "settings.browserProxyKindUrlWildcard",
  "host-regex": "settings.browserProxyKindHostRegex",
  "url-regex": "settings.browserProxyKindUrlRegex",
  "ip-cidr": "settings.browserProxyKindIpCidr",
};
const ISSUE_LABEL_KEY: Record<BrowserProxyRoutingIssue["code"], string> = {
  "invalid-shape": "settings.browserProxyIssueInvalidValue",
  "out-of-range": "settings.browserProxyIssueInvalidValue",
  "invalid-kind": "settings.browserProxyIssueInvalidKind",
  "invalid-pattern": "settings.browserProxyIssueInvalidPattern",
  "invalid-regex": "settings.browserProxyIssueInvalidRegex",
  "invalid-cidr": "settings.browserProxyIssueInvalidCidr",
  "invalid-url": "settings.browserProxyIssueInvalidUrl",
  "duplicate-id": "settings.browserProxyIssueDuplicateId",
  "unknown-target": "settings.browserProxyIssueUnknownTarget",
};

export function BrowserProxyRoutingDialog({ saved, saveSettings, onClose }: {
  saved: BrowserProxyRouting;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const titleId = useId();
  const panelId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const showToast = useAppStore((state) => state.showToast);
  const [draft, setDraft] = useState(saved);
  const [tab, setTab] = useState<"profiles" | "rules">("rules");
  const [issue, setIssue] = useState<BrowserProxyRoutingIssue | null>(null);
  const [testUrl, setTestUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;

  useEffect(() => { setDraft(saved); setIssue(null); }, [saved]);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    dialogRef.current?.querySelector<HTMLInputElement>(`[data-routing-id="${id}"] input`)?.focus();
  }, [draft]);
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Portalled menus own their focus and Escape handling.
      if (event.target instanceof Element && !dialogRef.current?.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        if (!busyRef.current) closeCallback.current();
      }
      if (event.key === "Tab") {
        const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ) ?? [])].filter((node) => node.getClientRects().length);
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const persist = async (next: BrowserProxyRouting) => {
    if (busyRef.current) return;
    setDraft(next);
    const result = validateBrowserProxyRouting(next);
    if (!result.ok) { setIssue(result.issue); return; }
    setIssue(null);
    if (JSON.stringify(result.value) === JSON.stringify(saved)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await saveSettings({ browserProxyRouting: result.value });
    } catch (error) {
      showToast(t("settings.browserProxyApplyFailed", {
        reason: error instanceof Error ? error.message : String(error),
      }), { variant: "error" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const issueText = (value: BrowserProxyRoutingIssue) => {
    const reason = t(ISSUE_LABEL_KEY[value.code]);
    if (value.index !== undefined) return t(value.scope === "profiles"
      ? "settings.browserProxyProfileError" : "settings.browserProxyRuleError",
    { index: value.index + 1, reason });
    return value.scope === "defaultTarget" ? t("settings.browserProxyDefaultError", { reason }) : reason;
  };
  const targetOptions = [
    { id: BROWSER_PROXY_DIRECT, label: t("settings.browserProxyDirect") },
    ...draft.profiles.map((profile) => ({ id: profile.id, label: profile.name || profile.url })),
  ];
  const testRoute = useMemo(() => {
    const request = browserProxyRequestForUrl(testUrl);
    return request ? matchBrowserProxyRoute(saved, request) : null;
  }, [saved, testUrl]);
  const targetLabel = (target: string) => target === BROWSER_PROXY_DIRECT
    ? t("settings.browserProxyDirect")
    : saved.profiles.find((profile) => profile.id === target)?.name
      || saved.profiles.find((profile) => profile.id === target)?.url || target;
  const close = () => { if (!busyRef.current) onClose(); };
  const add = () => {
    setIssue(null);
    const id = crypto.randomUUID();
    pendingFocus.current = id;
    if (tab === "profiles") {
      setDraft({ ...draft, profiles: [...draft.profiles, { id, name: "", url: "" }] });
    } else {
      setDraft({ ...draft, rules: [...draft.rules, { id, kind: "host-wildcard",
        pattern: "", target: draft.profiles[0]?.id ?? BROWSER_PROXY_DIRECT }] });
    }
  };

  return createPortal(
    <OverlayBackdrop className="overlay settings-routing-overlay" onClick={close}>
      <div ref={dialogRef} className="dialog settings-routing-dialog" role="dialog"
        aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="settings-routing-dialog-head">
          <div>
            <h3 id={titleId}>{t("settings.browserProxyRouting")}</h3>
            <p>{t(busy ? "common.saving" : "settings.browserProxyAutoSave")}</p>
          </div>
          <Button ref={closeRef} size="sm" variant="ghost" disabled={busy}
            aria-label={t("common.close")} onClick={close}><IconClose size={18} /></Button>
        </header>
        <div className="settings-routing-toolbar">
          <SegmentedControl value={tab} onChange={setTab} role="tablist"
            label={t("settings.browserProxyRouting")} options={[
              { value: "rules", label: `${t("settings.browserProxyRules")} (${draft.rules.length})`,
                id: `${panelId}-rules`, controls: panelId },
              { value: "profiles", label: `${t("settings.browserProxyProfiles")} (${draft.profiles.length})`,
                id: `${panelId}-profiles`, controls: panelId },
            ]} />
          <Button size="sm" variant="secondary" disabled={busy || (tab === "rules" ? draft.rules.length >= 200 : draft.profiles.length >= 32)} onClick={add}>
            {t(tab === "rules" ? "settings.browserProxyAddRule" : "settings.browserProxyAddProfile")}
          </Button>
        </div>
        <div className="settings-routing-list" id={panelId} role="tabpanel"
          aria-labelledby={`${panelId}-${tab}`} tabIndex={0}>
          <fieldset disabled={busy} className="settings-routing-fields">
            {tab === "rules" ? <>
              <div className="settings-routing-columns settings-routing-rule">
                <span aria-hidden="true">#</span><span>{t("settings.browserProxyRuleKind")}</span>
                <span>{t("settings.browserProxyRulePattern")}</span><span>{t("settings.browserProxyRuleTarget")}</span>
                <HelpIcon label={t("settings.browserProxyRulesDesc")} />
              </div>
              {draft.rules.map((rule, index) => (
                <div className="settings-routing-rule" data-routing-id={rule.id} key={rule.id}>
                  <span className="settings-routing-index">{index + 1}</span>
                  <SettingsMenuSelect value={rule.kind} label={t("settings.browserProxyRuleKind")}
                    disabled={busy} fullWidth options={BROWSER_PROXY_RULE_KINDS.map((kind) => ({ id: kind, label: t(KIND_LABEL_KEY[kind]) }))}
                    onChange={(kind) => {
                      const value = BROWSER_PROXY_RULE_KINDS.find((candidate) => candidate === kind);
                      if (value) void persist({ ...draft, rules: draft.rules.map((entry) => entry.id === rule.id ? { ...entry, kind: value } : entry) });
                    }} />
                  <Input value={rule.pattern} placeholder={t("settings.browserProxyRulePattern")}
                    aria-label={t("settings.browserProxyRulePattern")}
                    onChange={(event) => setDraft({ ...draft, rules: draft.rules.map((entry) => entry.id === rule.id ? { ...entry, pattern: event.target.value } : entry) })}
                    onBlur={() => void persist(draft)} />
                  <SettingsMenuSelect value={rule.target} label={t("settings.browserProxyRuleTarget")}
                    fullWidth disabled={busy} options={targetOptions}
                    onChange={(target) => void persist({ ...draft, rules: draft.rules.map((entry) => entry.id === rule.id ? { ...entry, target } : entry) })} />
                  <div className="settings-routing-actions">
                    <TooltipButton tooltip={t("settings.browserProxyMoveUp")} ariaLabel={t("settings.browserProxyMoveUp")}
                      disabled={busy || index === 0} onClick={() => void persist({ ...draft, rules: moveBrowserProxyRule(draft.rules, index, -1) })}>↑</TooltipButton>
                    <TooltipButton tooltip={t("settings.browserProxyMoveDown")} ariaLabel={t("settings.browserProxyMoveDown")}
                      disabled={busy || index === draft.rules.length - 1} onClick={() => void persist({ ...draft, rules: moveBrowserProxyRule(draft.rules, index, 1) })}>↓</TooltipButton>
                    <TooltipButton tooltip={t("settings.browserProxyDelete")} ariaLabel={t("settings.browserProxyDelete")}
                      disabled={busy} onClick={() => void persist({ ...draft, rules: draft.rules.filter((entry) => entry.id !== rule.id) })}><IconClose size={14} /></TooltipButton>
                  </div>
                </div>
              ))}
            </> : <>
              <div className="settings-routing-columns settings-routing-profile">
                <span>{t("settings.browserProxyProfileName")}</span><span>{t("settings.browserProxyProfileUrl")}</span>
              </div>
              {draft.profiles.map((profile) => (
                <div className="settings-routing-profile" data-routing-id={profile.id} key={profile.id}>
                  <Input value={profile.name} placeholder={t("settings.browserProxyProfileName")}
                    aria-label={t("settings.browserProxyProfileName")}
                    onChange={(event) => setDraft({ ...draft, profiles: draft.profiles.map((entry) => entry.id === profile.id ? { ...entry, name: event.target.value } : entry) })}
                    onBlur={() => void persist(draft)} />
                  <Input value={profile.url} placeholder={t("settings.proxyUrlPlaceholder")}
                    aria-label={t("settings.browserProxyProfileUrl")}
                    onChange={(event) => setDraft({ ...draft, profiles: draft.profiles.map((entry) => entry.id === profile.id ? { ...entry, url: event.target.value } : entry) })}
                    onBlur={() => void persist(draft)} />
                  <TooltipButton tooltip={t("settings.browserProxyDelete")} ariaLabel={t("settings.browserProxyDelete")}
                    disabled={busy} onClick={() => void persist(removeBrowserProxyProfile(draft, profile.id))}><IconClose size={14} /></TooltipButton>
                </div>
              ))}
            </>}
          </fieldset>
          {(tab === "rules" ? draft.rules : draft.profiles).length === 0
            ? <p className="settings-routing-empty">{t(tab === "rules" ? "settings.browserProxyEmptyRules" : "settings.browserProxyEmptyProfiles")}</p> : null}
        </div>
        <footer className="settings-routing-footer">
          {issue ? <p className="settings-routing-error" role="status">{issueText(issue)}</p> : null}
          <div className="settings-routing-default">
            <span>{t("settings.browserProxyDefaultTarget")}</span>
            <SettingsMenuSelect value={draft.defaultTarget} label={t("settings.browserProxyDefaultTarget")}
              disabled={busy} options={targetOptions} onChange={(defaultTarget) => void persist({ ...draft, defaultTarget })} />
          </div>
          <label className="settings-routing-test">
            <span>{t("settings.browserProxyTest")}</span>
            <Input value={testUrl} placeholder={t("settings.browserProxyTestPlaceholder")}
              onChange={(event) => setTestUrl(event.target.value)} />
          </label>
          {testUrl.trim() ? <p className="settings-routing-result" role="status">{testRoute
            ? t("settings.browserProxyTestResult", { url: testUrl.trim(), target: targetLabel(testRoute.target) })
            : t("settings.browserProxyTestInvalid")}</p> : null}
        </footer>
      </div>
    </OverlayBackdrop>, document.body,
  );
}
