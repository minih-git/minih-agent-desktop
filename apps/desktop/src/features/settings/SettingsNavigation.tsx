/**
 * The settings navigation: seven categories, then the destinations inside the
 * active one. Two levels, never three.
 *
 * When the seven labels do not fit the window, the same choice is offered as a
 * selector instead of a row the user has to scroll sideways.
 */
import type { RefObject } from "react";
import type { TFunction } from "i18next";
import type { PluginScenicThemesDestinationMeta } from "@minih-agent/shared";
import { Badge, cx } from "../../components/ui";
import { IconPalette } from "../../components/icons";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import type { SettingsTabId, VisibleSettingsCategory } from "../../lib/settings-search";

export function SettingsNavigation({
  t,
  categories,
  activeCategory,
  activeTab,
  activeExtension,
  extensions,
  extensionHits,
  searching,
  categoryOverflow,
  barRef,
  onSelectCategory,
  onSelectDestination,
  onOpenExtension,
}: {
  t: TFunction;
  categories: VisibleSettingsCategory[];
  activeCategory: VisibleSettingsCategory | undefined;
  activeTab: SettingsTabId;
  activeExtension: PluginScenicThemesDestinationMeta | null;
  extensions: PluginScenicThemesDestinationMeta[];
  extensionHits: PluginScenicThemesDestinationMeta[];
  searching: boolean;
  categoryOverflow: boolean;
  barRef: RefObject<HTMLElement | null>;
  onSelectCategory: (category: VisibleSettingsCategory) => void;
  onSelectDestination: (id: SettingsTabId) => void;
  onOpenExtension: (extension: PluginScenicThemesDestinationMeta) => void;
}) {
  const entries = activeCategory?.entries ?? [];
  const destinations = entries.length > 1 ? entries : [];

  return (
    <>
      {categoryOverflow ? (
        <div className="settings-category-bar no-drag">
          <SettingsMenuSelect
            className="settings-category-select"
            label={t("settings.categories")}
            value={activeCategory?.id ?? "general"}
            options={categories.map((category) => ({
              id: category.id,
              label: t(category.labelKey),
            }))}
            onChange={(id) => {
              const next = categories.find((category) => category.id === id);
              if (next) onSelectCategory(next);
            }}
          />
        </div>
      ) : (
        <nav
          ref={barRef as RefObject<HTMLElement>}
          className="settings-categories no-drag"
          role="tablist"
          aria-label={t("settings.categories")}
        >
          {categories.map((category) => {
            const selected = !activeExtension && category.id === activeCategory?.id;
            return (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cx("settings-nav-item", "settings-category", selected && "active")}
                onClick={() => onSelectCategory(category)}
              >
                {t(category.labelKey)}
              </button>
            );
          })}
        </nav>
      )}

      {destinations.length > 0 ? (
        <nav
          className="settings-subnav no-drag"
          role="tablist"
          aria-label={t("settings.sections")}
        >
          {destinations.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={!activeExtension && activeTab === entry.id}
              className={cx(
                "settings-nav-item",
                "settings-subnav-item",
                !activeExtension && activeTab === entry.id && "active",
              )}
              onClick={() => onSelectDestination(entry.id)}
            >
              <span className="settings-nav-label">{t(entry.labelKey)}</span>
              {entry.experimentalBadgeKey ? (
                <Badge tone="warning" className="settings-nav-experimental">
                  {t(entry.experimentalBadgeKey)}
                </Badge>
              ) : null}
            </button>
          ))}
          {activeCategory?.id === "general"
            ? extensions
                .filter((entry) => !searching || extensionHits.includes(entry))
                .map((entry) => {
                  const ExtensionIcon = pluginViewIcon(entry.icon) ?? IconPalette;
                  return (
                    <button
                      key={entry.ref}
                      type="button"
                      role="tab"
                      aria-selected={activeExtension?.ref === entry.ref}
                      className={cx(
                        "settings-nav-item",
                        "settings-subnav-item",
                        activeExtension?.ref === entry.ref && "active",
                      )}
                      onClick={() => onOpenExtension(entry)}
                    >
                      <span className="settings-nav-icon">
                        <ExtensionIcon size={14} />
                      </span>
                      <span className="settings-nav-label">{entry.label}</span>
                    </button>
                  );
                })
            : null}
        </nav>
      ) : null}
    </>
  );
}
