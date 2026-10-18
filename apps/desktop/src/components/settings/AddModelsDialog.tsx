/**
 * The add-models dialog: the gateway's whole catalog as selectable cards, one
 * page at a time, with search and vendor filter pills — the same plaza the
 * account panel offered, now the models page's entry into it.
 *
 * Selection survives paging, vendor filtering and searching (it is a set of
 * ids plus the plaza rows that carry them); models already on the row show as
 * added and cannot be re-picked.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MinihRouterModel, MinihRouterModelPage } from "@minih-agent/shared";
import { OverlayBackdrop, Button, Input, portalOverlay } from "../ui";
import { IconChevronLeft, IconChevronRight, IconSearch } from "../icons";
import { MinihRouterModelCard } from "./MinihRouterModelCard";
import {
  filterModelsByVendorAndQuery,
  summarizeModelVendors,
} from "./minih-router-format";
import {
  MINIH_ROUTER_MODEL_PAGE_SIZE,
  useMinihRouterCatalog,
  useMinihRouterModels,
} from "./useMinihRouter";

const SEARCH_DEBOUNCE_MS = 300;

export type AddModelsDialogProps = {
  providerId: string;
  /** Wire ids the row already carries; those cards render as added. */
  configuredIds: readonly string[];
  busy?: boolean;
  onClose: () => void;
  /** Confirms the selection; the caller saves and refreshes. */
  onConfirm: (models: MinihRouterModel[]) => void;
};

export function AddModelsDialog({
  providerId,
  configuredIds,
  busy,
  onClose,
  onConfirm,
}: AddModelsDialogProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selectedVendor, setSelectedVendor] = useState<string>("all");
  // Bumped by Retry: the hook refetches when its request key or this changes.
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Map<string, MinihRouterModel>>(new Map());

  // A typed search settles before it is sent, and always starts on page one.
  useEffect(() => {
    if (search === query) return;
    const timer = window.setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  const models = useMinihRouterModels(
    providerId,
    { page, pageSize: MINIH_ROUTER_MODEL_PAGE_SIZE, query },
    revision,
  );
  const catalog = useMinihRouterCatalog(providerId, revision);

  const otherVendorLabel = t("settings.minihRouterVendorOther");
  const vendorSummaries = useMemo(
    () => summarizeModelVendors(catalog.data ?? models.data?.items ?? [], otherVendorLabel),
    [catalog.data, models.data?.items, otherVendorLabel],
  );
  const totalCatalogCount = catalog.data?.length ?? models.data?.totalItems ?? 0;

  const activePageData: MinihRouterModelPage | null = useMemo(() => {
    if (selectedVendor === "all" || !catalog.data) {
      return models.data;
    }
    const filtered = filterModelsByVendorAndQuery(catalog.data, selectedVendor, query);
    const totalItems = filtered.length;
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / MINIH_ROUTER_MODEL_PAGE_SIZE) : 0;
    const safePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
    const start = (safePage - 1) * MINIH_ROUTER_MODEL_PAGE_SIZE;
    return {
      items: filtered.slice(start, start + MINIH_ROUTER_MODEL_PAGE_SIZE),
      page: safePage,
      pageSize: MINIH_ROUTER_MODEL_PAGE_SIZE,
      totalItems,
      totalPages,
    };
  }, [selectedVendor, catalog.data, models.data, query, page]);

  const configuredSet = useMemo(
    () => new Set(configuredIds.map((id) => id.toLowerCase())),
    [configuredIds],
  );

  const toggle = (model: MinihRouterModel) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(model.id)) next.delete(model.id);
      else next.set(model.id, model);
      return next;
    });
  };

  // Cards on the current page the row does not carry yet: select-all touches
  // exactly these, never the already-configured ones (they are not togglable).
  const selectableItems = useMemo(
    () =>
      (activePageData?.items ?? []).filter(
        (model) => !configuredSet.has(model.id.toLowerCase()),
      ),
    [activePageData?.items, configuredSet],
  );
  const allVisibleSelected =
    selectableItems.length > 0 &&
    selectableItems.every((model) => selected.has(model.id));
  const someVisibleSelected =
    !allVisibleSelected && selectableItems.some((model) => selected.has(model.id));

  const toggleAllVisible = (check: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      for (const model of selectableItems) {
        if (check) next.set(model.id, model);
        else next.delete(model.id);
      }
      return next;
    });
  };

  const confirm = () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    onConfirm([...selected.values()]);
  };

  return portalOverlay(
    <OverlayBackdrop
      className="overlay add-models-overlay"
      role="presentation"
      onClick={() => {
        if (busy) return;
        onClose();
      }}
    >
      <div
        className="dialog add-models-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-models-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="add-models-head">
          <h4 id="add-models-title" className="add-models-title">
            {t("settings.addModelsTitle")}
          </h4>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {t("settings.close")}
          </Button>
        </div>

        <div className="minih-router-search add-models-search">
          <IconSearch size={13} aria-hidden />
          <Input
            value={search}
            placeholder={t("settings.minihRouterSearchModels")}
            aria-label={t("settings.minihRouterSearchModels")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {vendorSummaries.length > 0 ? (
          <div
            className="add-models-vendor-tabs"
            role="tablist"
            aria-label={t("settings.minihRouterVendorAll")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selectedVendor === "all"}
              data-vendor-filter="all"
              className={
                selectedVendor === "all"
                  ? "add-models-vendor-pill is-active"
                  : "add-models-vendor-pill"
              }
              onClick={() => {
                setSelectedVendor("all");
                setPage(1);
              }}
            >
              <span>{t("settings.minihRouterVendorAll")}</span>
              {totalCatalogCount > 0 ? (
                <span className="add-models-vendor-count">{totalCatalogCount}</span>
              ) : null}
            </button>
            {vendorSummaries.map((vendor) => {
              const active = selectedVendor.toLowerCase() === vendor.key.toLowerCase();
              return (
                <button
                  key={vendor.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-vendor-filter={vendor.key}
                  className={
                    active ? "add-models-vendor-pill is-active" : "add-models-vendor-pill"
                  }
                  onClick={() => {
                    setSelectedVendor(vendor.key);
                    setPage(1);
                  }}
                >
                  <span>{vendor.label}</span>
                  <span className="add-models-vendor-count">{vendor.count}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="add-models-toolbar">
          {activePageData && activePageData.items.length > 0 ? (
            <label className="add-models-select-all">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={busy || selectableItems.length === 0}
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected;
                }}
                aria-label={
                  allVisibleSelected
                    ? t("settings.deselectAllVisibleModels")
                    : t("settings.selectAllVisibleModels")
                }
                onChange={(event) => toggleAllVisible(event.target.checked)}
              />
              <span>
                {allVisibleSelected
                  ? t("settings.deselectAllVisibleModels")
                  : t("settings.selectAllVisibleModels")}
              </span>
            </label>
          ) : (
            <span />
          )}
          <p className="minih-router-price-hint">{t("settings.minihRouterPriceHint")}</p>
        </div>

        <div className="add-models-body">
          {models.state === "error" ? (
            <div className="minih-router-status is-error" role="alert">
              <span>{t("settings.minihRouterModelsFailed")}</span>
              <span className="minih-router-status-detail">{models.message}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                {t("settings.minihRouterRetry")}
              </Button>
            </div>
          ) : null}
          {activePageData === null && models.state === "loading" ? (
            <p className="minih-router-status">{t("settings.minihRouterLoading")}</p>
          ) : null}
          {activePageData && activePageData.items.length === 0 ? (
            <p className="minih-router-status">{t("settings.minihRouterModelsEmpty")}</p>
          ) : null}
          {activePageData && activePageData.items.length > 0 ? (
            <ul
              className="minih-router-model-grid add-models-grid"
              data-model-section="plaza"
              aria-busy={models.state === "loading" ? "true" : undefined}
            >
              {activePageData.items.map((model) => (
                <MinihRouterModelCard
                  key={model.id}
                  model={model}
                  locale={locale}
                  configured={configuredSet.has(model.id.toLowerCase())}
                  selectable
                  selected={selected.has(model.id) || configuredSet.has(model.id.toLowerCase())}
                  busy={busy}
                  onToggle={(candidate) => {
                    if (configuredSet.has(candidate.id.toLowerCase())) return;
                    toggle(candidate);
                  }}
                />
              ))}
            </ul>
          ) : null}
        </div>

        {activePageData && activePageData.totalPages > 1 ? (
          <nav className="minih-router-pagination" aria-label={t("settings.minihRouterModels")}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("settings.minihRouterPrevPage")}
              disabled={activePageData.page <= 1 || models.state === "loading"}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <IconChevronLeft size={14} />
            </Button>
            <span className="minih-router-page-status">
              {t("settings.minihRouterPageStatus", {
                page: activePageData.page,
                pages: activePageData.totalPages,
                total: activePageData.totalItems,
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("settings.minihRouterNextPage")}
              disabled={activePageData.page >= activePageData.totalPages || models.state === "loading"}
              onClick={() => setPage((value) => value + 1)}
            >
              <IconChevronRight size={14} />
            </Button>
          </nav>
        ) : null}

        <div className="add-models-foot">
          <span className="add-models-count">
            {t("settings.addModelsSelected", { count: selected.size })}
          </span>
          <div className="add-models-foot-actions">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || selected.size === 0}
              onClick={confirm}
            >
              <span className="model-config-btn-inner">
                <span>{t("settings.addModelsConfirm")}</span>
              </span>
            </Button>
          </div>
        </div>
      </div>
    </OverlayBackdrop>,
  );
}
