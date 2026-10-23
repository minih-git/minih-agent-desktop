import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, PluginScenicThemesDestinationMeta, ShortcutPlatform } from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  isSettingsDestinationHidden,
  searchSettings,
  settingsHitPath,
  visibleSettingsCategories,
  visibleSettingsNav,
  type SettingsSearchHit,
  type SettingsTabId,
  type VisibleSettingsCategory,
} from "../../lib/settings-search";
import { useBlockingOverlayActive } from "../../lib/blocking-overlay";
import { Button, TooltipButton, cx } from "../../components/ui";
import { IconSearch, IconX } from "../../components/icons";
import { LearnedMemoryDialog } from "../../components/LearnedMemoryDialog";
import { SettingsDestination } from "./SettingsDestination";
import { SettingsNavigation } from "./SettingsNavigation";
import { SettingsDraftProvider, useSettingsDraftRegistry, type SettingsBlock } from "./draft-guard";

type Editable = HTMLInputElement | HTMLTextAreaElement;

function isEditable(node: EventTarget | null): node is Editable {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement
  );
}

/**
 * The settings panel: a near full-height sheet that slides up from the window
 * bottom, with seven fixed categories and at most one second level.
 *
 * The chat shell stays mounted behind it (inert, in the shell), so drafts,
 * transcript scroll, sidebar collapse, and the work panel survive a visit. The
 * panel owns its own focus trap, protects explicitly saved forms, and closes
 * only the top-most surface.
 */
export function SettingsPage({
  exiting = false,
  onExited,
}: {
  /** The page already changed; the panel is playing its exit animation. */
  exiting?: boolean;
  onExited?: () => void;
} = {}) {
  const { t, i18n } = useTranslation();
  const tab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const settingsAnchor = useAppStore((s) => s.settingsAnchor);
  const settingsTabNonce = useAppStore((s) => s.settingsTabNonce);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const setPage = useAppStore((s) => s.setPage);
  const settings = useAppStore((s) => s.settings);
  const providers = useAppStore((s) => s.providers);
  const version = useAppStore((s) => s.version);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const platform = (window.minihAgent?.platform ?? "darwin") as ShortcutPlatform;

  // Experimental feature surfaces remain available in development builds only.
  const includeDevelopmentOnly = import.meta.env.DEV;
  const developerMode = settings?.developerMode === true;
  const navEntries = useMemo(
    () => visibleSettingsNav(developerMode, includeDevelopmentOnly),
    [developerMode, includeDevelopmentOnly],
  );
  const categories = useMemo(
    () => visibleSettingsCategories(developerMode, includeDevelopmentOnly),
    [developerMode, includeDevelopmentOnly],
  );
  const tabHidden = isSettingsDestinationHidden(
    tab,
    developerMode,
    includeDevelopmentOnly,
  );

  const [query, setQuery] = useState("");
  const [recoveringSettings, setRecoveringSettings] = useState(!settings);
  const [settingsRecoveryFailed, setSettingsRecoveryFailed] = useState(false);
  const [extensions, setExtensions] = useState<PluginScenicThemesDestinationMeta[]>([]);
  const [activeExtension, setActiveExtension] = useState<PluginScenicThemesDestinationMeta | null>(null);
  const [learnedMemoryOpen, setLearnedMemoryOpen] = useState(false);
  const [categoryOverflow, setCategoryOverflow] = useState(false);
  // A leave that waits for the draft decision. Holding the action keeps every
  // way out — category, tab, search result, scrim, Escape, close — identical.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const draftRegistry = useSettingsDraftRegistry();
  const seenSettingsTabNonce = useRef(settingsTabNonce);
  // setSettingsTab means "show this built-in category", even when the tab id
  // does not change. Dismiss a plugin page before paint; an anchor-only deep
  // link has to do the same or the row lookup hits the plugin instead.
  if (
    seenSettingsTabNonce.current !== settingsTabNonce ||
    (activeExtension && settingsAnchor)
  ) {
    seenSettingsTabNonce.current = settingsTabNonce;
    if (activeExtension) setActiveExtension(null);
  }
  const contentRef = useRef<HTMLDivElement>(null);
  const settingsSearchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const categoryBarRef = useRef<HTMLElement>(null);
  const panelTitleId = useId();
  const nestingActive = useBlockingOverlayActive();
  const destination = activeExtension ? `extension:${activeExtension.ref}` : `builtin:${tab}`;

  // Focus enters the search control, and leaves with the panel: a close has to
  // return the keyboard to the entry the user came from.
  useLayoutEffect(() => {
    const previous = document.activeElement;
    settingsSearchRef.current?.focus({ preventScroll: true });
    return () => {
      // The shell releases `inert` in the same commit that unmounts this sheet,
      // so the restore waits one frame: focusing an inert element is a no-op.
      window.requestAnimationFrame(() => {
        if (previous instanceof HTMLElement && previous.isConnected) {
          previous.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  useLayoutEffect(() => {
    // Reset before paint and before the search-anchor effect positions its row.
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [destination]);

  useEffect(() => {
    const refresh = () => void api.listPluginScenicThemesDestinations().then(setExtensions, () => setExtensions([]));
    refresh();
    return api.onPluginChanged(refresh);
  }, []);

  useEffect(() => {
    if (activeExtension && !extensions.some((entry) => entry.ref === activeExtension.ref)) {
      setActiveExtension(null);
      setSettingsTab("general");
    }
  }, [activeExtension, extensions, setSettingsTab]);

  // A hidden destination must not keep rendering: leave the page the panel no
  // longer offers (for example Cloud sync or Advanced after a build without
  // experimental surfaces) and fall back to the first visible one.
  useEffect(() => {
    if (!settings || !tabHidden) return;
    setSettingsTab("general");
  }, [settings, tabHidden, setSettingsTab]);

  const recoverSettings = useCallback(async () => {
    setRecoveringSettings(true);
    setSettingsRecoveryFailed(false);
    try {
      const recovered = await api.getSettings();
      useAppStore.setState({ settings: recovered });
    } catch {
      setSettingsRecoveryFailed(true);
    } finally {
      setRecoveringSettings(false);
    }
  }, []);

  useEffect(() => {
    if (settings) return;
    void recoverSettings();
  }, [settings, recoverSettings]);

  /**
   * Rows that search should land on can name themselves, which is how a hit
   * inside a folded container is found: the title lookup alone cannot reach a
   * field the disclosure has collapsed.
   */
  const resolveAnchor = useCallback((key: string): HTMLElement | null => {
    const explicit = document.querySelector<HTMLElement>(
      `.settings-content [data-settings-anchor="${key}"]`,
    );
    if (explicit) return explicit;
    const target = t(key).trim();
    const titles = document.querySelectorAll<HTMLElement>(
      ".settings-content .settings-row-title, .settings-content .settings-card-heading, .settings-content .about-update-title",
    );
    const match = [...titles].find((node) => node.textContent?.trim() === target);
    if (!match) return null;
    return (
      match.closest<HTMLElement>(".settings-row") ??
      match.closest<HTMLElement>(".settings-card-block") ??
      match
    );
  }, [t]);

  // Arriving from the global search dialog (or the panel's own results): expand
  // whatever folds the target, then scroll to and flash it. This runs after the
  // destination reset and before paint, so a category change does not flash the
  // top. A short retry window covers content that mounts late.
  useLayoutEffect(() => {
    if (!settingsAnchor) return;
    let cancelled = false;
    let timer: number | undefined;
    const tryFind = (attempt: number) => {
      if (cancelled) return;
      const row = resolveAnchor(settingsAnchor);
      if (row) {
        for (let node = row.parentElement; node; node = node.parentElement) {
          if (node instanceof HTMLDetailsElement) node.open = true;
        }
        row.scrollIntoView({ block: "center" });
        row.classList.add("settings-anchor-flash");
        window.setTimeout(() => row.classList.remove("settings-anchor-flash"), 1800);
        setSettingsAnchor(null);
        return;
      }
      if (attempt < 8) timer = window.setTimeout(() => tryFind(attempt + 1), 120);
      else setSettingsAnchor(null);
    };
    tryFind(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [settingsAnchor, tab, resolveAnchor, setSettingsAnchor]);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const nextSettings = { ...settings, ...patch };
    await api.setSettings(nextSettings);
    useAppStore.setState({ settings: nextSettings });
    await refreshProviders();
  };

  const selectPluginTheme = async (theme: string) => {
    await saveSettings({ theme: theme as AppSettings["theme"] });
  };

  const closeSettings = useCallback(() => setPage("chat"), [setPage]);

  /**
   * Every exit goes through here: a form that saves explicitly gets to keep its
   * work until the user decides, and an in-flight save is never overtaken.
   */
  const requestLeave = useCallback((action: () => void) => {
    if (draftRegistry.blocked() === "none") {
      action();
      return;
    }
    setPendingLeave(() => action);
  }, [draftRegistry]);

  const discardAndLeave = () => {
    const action = pendingLeave;
    setPendingLeave(null);
    action?.();
  };

  /**
   * A nested menu, editor, or dialog owns its own Escape. The registry alone is
   * not enough: some editors portal their surface and bubble the event back to
   * this panel, so the live DOM decides.
   */
  const innerSurfaceOpen = useCallback(() => {
    if (nestingActive) return true;
    const visible = (node: Element) => {
      const box = node.getBoundingClientRect();
      return box.width > 1 && box.height > 1;
    };
    const host = document.getElementById("minih-agent-desktop-overlays");
    if (host && [...host.children].some(visible)) return true;
    const panel = panelRef.current;
    return [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')]
      .some((node) => !panel?.contains(node) && visible(node));
  }, [nestingActive]);

  const editingField = useCallback(() => {
    const node = document.activeElement;
    if (!isEditable(node) || node.classList.contains("settings-search")) return false;
    return node.closest(".settings-sheet") !== null;
  }, []);

  // Escape is listened for on the document, after every inner surface had its
  // chance to handle it: the panel only acts when nothing else is on top.
  useEffect(() => {
    if (exiting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (pendingLeave || innerSurfaceOpen()) return;
      if (query.trim()) {
        event.preventDefault();
        setQuery("");
        return;
      }
      if (editingField()) {
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      event.preventDefault();
      requestLeave(closeSettings);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSettings, editingField, exiting, innerSurfaceOpen, pendingLeave, query, requestLeave]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (exiting) return;
    if (event.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };

  const onScrimPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (exiting || event.target !== event.currentTarget) return;
    // A dirty or saving form decides; an untouched sheet closes on the scrim.
    if (innerSurfaceOpen()) return;
    requestLeave(closeSettings);
  };

  const activeCategory: VisibleSettingsCategory | undefined =
    categories.find((category) => category.entries.some((entry) => entry.id === tab)) ??
    categories[0];
  const categoryEntries = activeCategory?.entries ?? [];
  const activeEntry = navEntries.find((entry) => entry.id === tab);
  const activeTitleKey = activeEntry?.titleKey ?? "settings.title";
  const activeBadgeKey = activeEntry?.experimentalBadgeKey;

  // Seven short labels fit most windows; when they do not, the same choice is
  // offered as a selector instead of a row that silently scrolls.
  useLayoutEffect(() => {
    if (categoryOverflow) return;
    const bar = categoryBarRef.current;
    if (!bar) return;
    if (bar.scrollWidth > bar.clientWidth + 1) setCategoryOverflow(true);
  });
  useEffect(() => {
    if (!categoryOverflow) return;
    const remeasure = () => setCategoryOverflow(false);
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, [categoryOverflow]);
  // A different language (or a fresh type scale) changes the labels, so the
  // measurement is taken again before the selector can outlive that change.
  useEffect(() => {
    setCategoryOverflow(false);
  }, [i18n.resolvedLanguage]);

  const selectCategory = (category: VisibleSettingsCategory) => {
    const firstEntry = category.entries[0];
    const alreadyHere = category.entries.some((entry) => entry.id === tab) && !activeExtension;
    if (alreadyHere || !firstEntry) return;
    requestLeave(() => {
      setActiveExtension(null);
      setSettingsTab(firstEntry.id);
    });
  };

  const selectDestination = (id: SettingsTabId) => {
    setActiveExtension(null);
    setSettingsTab(id);
  };

  const q = query.trim().toLowerCase();
  const hits = useMemo(
    () =>
      searchSettings(query, t, {
        limit: 12,
        developerMode,
        includeDevelopmentOnly,
      }),
    [query, t, developerMode, includeDevelopmentOnly],
  );
  const extensionHits = q
    ? extensions.filter((entry) =>
        [entry.label, entry.description, ...entry.keywords].some((value) =>
          value.toLowerCase().includes(q),
        ),
      )
    : [];
  const searching = q.length > 0;

  const openHit = (hit: SettingsSearchHit) => {
    requestLeave(() => {
      setQuery("");
      setActiveExtension(null);
      setSettingsAnchor(hit.rowKey);
      setSettingsTab(hit.tab);
    });
  };

  const openExtension = (extension: PluginScenicThemesDestinationMeta) => {
    requestLeave(() => {
      setQuery("");
      setActiveExtension(extension);
    });
  };

  const block: SettingsBlock = pendingLeave ? draftRegistry.blocked() : "none";

  return (
    <SettingsDraftProvider value={draftRegistry}>
      <div
        className={cx("settings-overlay", exiting && "is-exiting")}
        onPointerDown={onScrimPointerDown}
      >
        <div
          ref={panelRef}
          className={cx("settings-sheet", exiting && "is-exiting")}
          role="dialog"
          aria-modal="true"
          aria-labelledby={panelTitleId}
          onKeyDown={onPanelKeyDown}
          onAnimationEnd={(event) => {
            if (!exiting || event.target !== event.currentTarget) return;
            onExited?.();
          }}
        >
          {/* The head is the native drag region: no decorative plate is painted
              over it, so the title, search, and close stay visible. */}
          <header className="settings-panel-head drag">
            <h1 id={panelTitleId} className="settings-panel-title">
              {t("settings.title")}
            </h1>
            <div className="settings-search-wrap no-drag">
              <IconSearch size={14} />
              <input
                ref={settingsSearchRef}
                className="settings-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.searchPlaceholder")}
                aria-label={t("settings.search")}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </div>
            <TooltipButton
              type="button"
              className="settings-close no-drag"
              tooltip={t("settings.close")}
              ariaLabel={t("settings.close")}
              data-nav="close-settings"
              onClick={() => requestLeave(closeSettings)}
            >
              <IconX size={16} />
            </TooltipButton>
          </header>

          <SettingsNavigation
            t={t}
            categories={categories}
            activeCategory={activeCategory}
            activeTab={tab}
            activeExtension={activeExtension}
            extensions={extensions}
            extensionHits={extensionHits}
            searching={searching}
            categoryOverflow={categoryOverflow}
            barRef={categoryBarRef}
            onSelectCategory={selectCategory}
            onSelectDestination={(id) =>
              requestLeave(() => selectDestination(id))
            }
            onOpenExtension={openExtension}
          />

          <div className="settings-content-area">
            <div className="settings-content" ref={contentRef}>
              <div className="settings-content-inner">
                <div className="settings-content-enter">
                  <SettingsDestination
                    t={t}
                    tab={tab}
                    titleKey={activeTitleKey}
                    badgeKey={activeBadgeKey}
                    tabHidden={tabHidden}
                    activeExtension={activeExtension}
                    extensions={extensions}
                    settings={settings}
                    providers={providers}
                    version={version}
                    platform={platform}
                    recoveringSettings={recoveringSettings}
                    settingsRecoveryFailed={settingsRecoveryFailed}
                    recoverSettings={recoverSettings}
                    saveSettings={saveSettings}
                    selectPluginTheme={selectPluginTheme}
                    onOpenExtension={openExtension}
                    onOpenMemoryManager={() => setLearnedMemoryOpen(true)}
                  />
                </div>
              </div>
            </div>

            {/* Search results sit over the page instead of replacing it: the
                destination stays mounted, so an unsaved draft survives a query
                and clearing it. */}
            {searching ? (
              <div
                className="settings-results-panel"
                role="listbox"
                aria-label={t("settings.searchResults")}
              >
                <h2 className="settings-section-title">{t("settings.searchResults")}</h2>
                {hits.length === 0 && extensionHits.length === 0 ? (
                  <div className="settings-nav-empty">{t("settings.noResults")}</div>
                ) : null}
                {hits.map((hit) => (
                  <button
                    key={`${hit.tab}:${hit.rowKey ?? "tab"}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="settings-result"
                    onClick={() => openHit(hit)}
                  >
                    <span className="settings-result-title">
                      {t(hit.rowKey ?? hit.tabLabelKey)}
                    </span>
                    <span className="settings-result-path">
                      {settingsHitPath(hit).map((key) => t(key)).join(" › ")}
                    </span>
                  </button>
                ))}
                {extensionHits.map((entry) => (
                  <button
                    key={entry.ref}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="settings-result"
                    onClick={() => openExtension(entry)}
                  >
                    <span className="settings-result-title">{entry.label}</span>
                    <span className="settings-result-path">
                      {[t("settings.category.general"), t("settings.nav.appearance"), entry.label].join(" › ")}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {pendingLeave ? (
          <div className="settings-draft-scrim">
            <div
              className="settings-draft-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={`${panelTitleId}-draft-title`}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setPendingLeave(null);
              }}
            >
              <h2 id={`${panelTitleId}-draft-title`} className="settings-draft-title">
                {t("settings.draftConfirmTitle")}
              </h2>
              <p className="settings-draft-description">
                {block === "saving"
                  ? t("settings.draftSavingNote")
                  : t("settings.draftConfirmDescription")}
              </p>
              <div className="settings-draft-actions">
                <Button variant="secondary" onClick={() => setPendingLeave(null)}>
                  {t("settings.draftKeepEditing")}
                </Button>
                <Button
                  variant="primary"
                  disabled={block === "saving"}
                  onClick={discardAndLeave}
                >
                  {t("settings.draftDiscard")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {learnedMemoryOpen ? (
          <LearnedMemoryDialog
            scope="user"
            onClose={() => setLearnedMemoryOpen(false)}
            onError={(error) => console.warn("learned memory request failed", error)}
          />
        ) : null}
      </div>
    </SettingsDraftProvider>
  );
}
