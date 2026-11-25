/**
 * Settings → System → Network: per-address proxy routing for the built-in
 * browser (ADR 0342).
 *
 * The card edits one ordered rule list plus the proxies it can point at, and
 * applies on every change. Rows that cannot be applied yet — a new proxy with
 * no URL, a new rule with no pattern — stay in the draft and are simply not
 * saved, so the editor never posts a table host-core would refuse.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  BrowserProxyProfile,
  BrowserProxyRoute,
  BrowserProxyRouting,
  BrowserProxyRoutingIssue,
  BrowserProxyRule,
  BrowserProxyRuleKind,
} from "@minih-agent/shared";
import {
  BROWSER_PROXY_DIRECT,
  BROWSER_PROXY_RULE_KINDS,
  browserProxyRequestForUrl,
  emptyBrowserProxyRouting,
  matchBrowserProxyRoute,
  moveBrowserProxyRule,
  removeBrowserProxyProfile,
  validateBrowserProxyRouting,
} from "@minih-agent/shared";
import { Button, Input, Select, SettingsToggle } from "../ui";
import { SettingsRow } from "../../features/settings/primitives";
import { useAppStore } from "../../stores/app-store";

const KIND_LABEL_KEY: Record<BrowserProxyRuleKind, string> = {
  "host-wildcard": "settings.browserProxyKindHostWildcard",
  "url-wildcard": "settings.browserProxyKindUrlWildcard",
  "host-regex": "settings.browserProxyKindHostRegex",
  "url-regex": "settings.browserProxyKindUrlRegex",
  "ip-cidr": "settings.browserProxyKindIpCidr",
};

const ISSUE_LABEL_KEY: Record<string, string> = {
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

let idCounter = 0;

function newId(prefix: string): string {
  idCounter += 1;
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}${idCounter}`;
}

export function BrowserProxyRoutingSection({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const saved = useMemo(
    () => settings.browserProxyRouting ?? emptyBrowserProxyRouting(),
    [settings.browserProxyRouting],
  );
  const [draft, setDraft] = useState<BrowserProxyRouting>(saved);
  const [issue, setIssue] = useState<BrowserProxyRoutingIssue | null>(null);
  const [testUrl, setTestUrl] = useState("");

  useEffect(() => {
    setDraft(saved);
    setIssue(null);
  }, [saved]);

  const issueText = (value: BrowserProxyRoutingIssue): string => {
    const reason = t(ISSUE_LABEL_KEY[value.code] ?? "settings.browserProxyIssueInvalidValue");
    if (value.index === undefined) {
      return value.scope === "defaultTarget"
        ? t("settings.browserProxyDefaultError", { reason })
        : reason;
    }
    return value.scope === "profiles"
      ? t("settings.browserProxyProfileError", { index: value.index + 1, reason })
      : t("settings.browserProxyRuleError", { index: value.index + 1, reason });
  };

  const persist = async (next: BrowserProxyRouting) => {
    setDraft(next);
    const result = validateBrowserProxyRouting(next);
    if (!result.ok) {
      setIssue(result.issue);
      return;
    }
    setIssue(null);
    try {
      await saveSettings({ browserProxyRouting: result.value });
    } catch {
      showToast(t("settings.browserProxySaveError"), { variant: "error" });
    }
  };

  const profiles = draft.profiles;
  const targetOptions = [
    { value: BROWSER_PROXY_DIRECT, label: t("settings.browserProxyDirect") },
    ...profiles.map((profile) => ({
      value: profile.id,
      label: profile.name || profile.url,
    })),
  ];

  const updateProfile = (
    index: number,
    patch: Partial<BrowserProxyProfile>,
  ) => {
    const next = [...draft.profiles];
    next[index] = { ...next[index], ...patch };
    setDraft({ ...draft, profiles: next });
  };

  const updateRule = (index: number, patch: Partial<BrowserProxyRule>) => {
    const next = [...draft.rules];
    next[index] = { ...next[index], ...patch };
    setDraft({ ...draft, rules: next });
  };

  const addProfile = () => {
    const next: BrowserProxyRouting = {
      ...draft,
      enabled: true,
      profiles: [
        ...draft.profiles,
        { id: newId("proxy"), name: "", url: "" },
      ],
    };
    setDraft(next);
    setIssue(null);
  };

  const addRule = () => {
    const next: BrowserProxyRouting = {
      ...draft,
      enabled: true,
      rules: [
        ...draft.rules,
        {
          id: newId("rule"),
          kind: "host-wildcard",
          pattern: "",
          target: profiles[0]?.id ?? BROWSER_PROXY_DIRECT,
        },
      ],
    };
    setDraft(next);
    setIssue(null);
  };

  const testRoute = useMemo((): BrowserProxyRoute | null => {
    const request = browserProxyRequestForUrl(testUrl);
    if (!request) return null;
    return matchBrowserProxyRoute(saved, request);
  }, [testUrl, saved]);

  const testTargetLabel = (target: string): string => {
    if (target === BROWSER_PROXY_DIRECT) return t("settings.browserProxyDirect");
    const profile = saved.profiles.find((candidate) => candidate.id === target);
    return profile?.name || profile?.url || target;
  };

  return (
    <section className="settings-card-block">
      <h3 className="settings-card-heading">{t("settings.browserProxyRouting")}</h3>
      <div className="settings-panel">
        <SettingsRow
          title={t("settings.browserProxyRouting")}
          description={t("settings.browserProxyRoutingDesc")}
        >
          <SettingsToggle
            checked={draft.enabled}
            label={t("settings.browserProxyRouting")}
            onChange={() => void persist({ ...draft, enabled: !draft.enabled })}
          />
        </SettingsRow>

        {draft.enabled ? (
          <>
            <div className="settings-routing-block">
              <div className="settings-routing-head">
                <span>{t("settings.browserProxyProfiles")}</span>
                <Button size="sm" variant="secondary" onClick={addProfile}>
                  {t("settings.browserProxyAddProfile")}
                </Button>
              </div>
              {profiles.map((profile, index) => (
                <div className="settings-routing-row" key={profile.id}>
                  <Input
                    value={profile.name}
                    placeholder={t("settings.browserProxyProfileName")}
                    aria-label={t("settings.browserProxyProfileName")}
                    onChange={(event) =>
                      updateProfile(index, { name: event.target.value })
                    }
                    onBlur={() => void persist(draft)}
                  />
                  <Input
                    value={profile.url}
                    placeholder={t("settings.proxyUrlPlaceholder")}
                    aria-label={t("settings.browserProxyProfileUrl")}
                    onChange={(event) =>
                      updateProfile(index, { url: event.target.value })
                    }
                    onBlur={() => void persist(draft)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("settings.browserProxyDelete")}
                    onClick={() =>
                      void persist(removeBrowserProxyProfile(draft, profile.id))
                    }
                  >
                    {t("settings.browserProxyDelete")}
                  </Button>
                </div>
              ))}
            </div>

            <div className="settings-routing-block">
              <div className="settings-routing-head">
                <span>{t("settings.browserProxyRules")}</span>
                <Button size="sm" variant="secondary" onClick={addRule}>
                  {t("settings.browserProxyAddRule")}
                </Button>
              </div>
              <p className="settings-routing-hint">
                {t("settings.browserProxyRulesDesc")}
              </p>
              {draft.rules.map((rule, index) => (
                <div className="settings-routing-row" key={rule.id}>
                  <Select
                    value={rule.kind}
                    aria-label={t("settings.browserProxyRuleKind")}
                    onChange={(event) =>
                      void persist({
                        ...draft,
                        rules: draft.rules.map((entry) =>
                          entry.id === rule.id
                            ? { ...entry, kind: event.target.value as BrowserProxyRuleKind }
                            : entry,
                        ),
                      })
                    }
                  >
                    {BROWSER_PROXY_RULE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(KIND_LABEL_KEY[kind])}
                      </option>
                    ))}
                  </Select>
                  <Input
                    value={rule.pattern}
                    placeholder={t("settings.browserProxyRulePattern")}
                    aria-label={t("settings.browserProxyRulePattern")}
                    onChange={(event) =>
                      updateRule(index, { pattern: event.target.value })
                    }
                    onBlur={() => void persist(draft)}
                  />
                  <Select
                    value={rule.target}
                    aria-label={t("settings.browserProxyRuleTarget")}
                    onChange={(event) =>
                      void persist({
                        ...draft,
                        rules: draft.rules.map((entry) =>
                          entry.id === rule.id
                            ? { ...entry, target: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  >
                    {targetOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("settings.browserProxyMoveUp")}
                    disabled={index === 0}
                    onClick={() =>
                      void persist({
                        ...draft,
                        rules: moveBrowserProxyRule(draft.rules, index, -1),
                      })
                    }
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("settings.browserProxyMoveDown")}
                    disabled={index === draft.rules.length - 1}
                    onClick={() =>
                      void persist({
                        ...draft,
                        rules: moveBrowserProxyRule(draft.rules, index, 1),
                      })
                    }
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("settings.browserProxyDelete")}
                    onClick={() =>
                      void persist({
                        ...draft,
                        rules: draft.rules.filter((entry) => entry.id !== rule.id),
                      })
                    }
                  >
                    {t("settings.browserProxyDelete")}
                  </Button>
                </div>
              ))}
            </div>

            <SettingsRow title={t("settings.browserProxyDefaultTarget")}>
              <Select
                value={draft.defaultTarget}
                aria-label={t("settings.browserProxyDefaultTarget")}
                onChange={(event) =>
                  void persist({ ...draft, defaultTarget: event.target.value })
                }
              >
                {targetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </SettingsRow>

            <SettingsRow title={t("settings.browserProxyTest")}>
              <div className="settings-proxy-control">
                <Input
                  value={testUrl}
                  placeholder={t("settings.browserProxyTestPlaceholder")}
                  aria-label={t("settings.browserProxyTest")}
                  onChange={(event) => setTestUrl(event.target.value)}
                />
                {testUrl.trim() ? (
                  <span role="status">
                    {testRoute
                      ? t("settings.browserProxyTestResult", {
                          url: testUrl.trim(),
                          target: testTargetLabel(testRoute.target),
                        })
                      : t("settings.browserProxyTestInvalid")}
                  </span>
                ) : null}
              </div>
            </SettingsRow>
          </>
        ) : null}

        {issue ? (
          <p className="settings-routing-error" role="status">
            {issueText(issue)}
          </p>
        ) : null}
      </div>
    </section>
  );
}