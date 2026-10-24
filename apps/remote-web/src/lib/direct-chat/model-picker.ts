/**
 * Pure presentation projection for the model picker (ADR mobile-redesign D1, D2, bug B13).
 *
 * All capability classification comes from `catalog.ts` (`capabilityChips`,
 * `splitDirectModels`, `splitDirectImageModels`, `filterDirectModels`). This
 * module groups the classified rows by vendor, formats context-window and price
 * hints when the gateway declared them, and assigns deterministic vendor badge
 * monograms for the picker and conversation list rows.
 */
import type { MinihRouterModel } from "@minih-agent/shared";

import {
  capabilityChips,
  filterDirectModels,
  splitDirectImageModels,
  splitDirectModels,
  type DirectProtocol,
  type ModelCapabilityChip,
  type ModelUnavailableReason,
} from "./catalog.js";

export type PickerMode = "chat" | "image";

export type PickerModelRow = {
  model: MinihRouterModel;
  protocol?: DirectProtocol;
  chips: ModelCapabilityChip[];
  contextBadge: string | null;
  priceText: string | null;
};

export type PickerVendorGroup = {
  vendor: string;
  rows: PickerModelRow[];
};

export type PickerView = {
  vendorGroups: PickerVendorGroup[];
};

const VENDOR_GRADIENTS: readonly string[] = [
  "bg-[linear-gradient(135deg,#10a37f,#0d7a5f)]",
  "bg-[linear-gradient(135deg,#d97757,#b4532a)]",
  "bg-[linear-gradient(135deg,#4f6bff,#2a3bd1)]",
  "bg-[linear-gradient(135deg,#4285f4,#a142f4)]",
  "bg-[linear-gradient(135deg,#7c3aed,#c026d3)]",
];

/**
 * Deterministic 2-letter monogram and gradient class for a vendor or model id.
 */
export function vendorBadge(
  vendor: string | null | undefined,
  modelId: string | null | undefined,
): { monogram: string; gradientClass: string } {
  const source = `${vendor ?? ""} ${modelId ?? ""}`.toLowerCase();
  if (source.includes("openai") || source.includes("gpt") || source.includes("dall-e") || source.includes("o1") || source.includes("o3")) {
    return { monogram: "GP", gradientClass: VENDOR_GRADIENTS[0]! };
  }
  if (source.includes("anthropic") || source.includes("claude")) {
    return { monogram: "CL", gradientClass: VENDOR_GRADIENTS[1]! };
  }
  if (source.includes("deepseek")) {
    return { monogram: "DS", gradientClass: VENDOR_GRADIENTS[2]! };
  }
  if (source.includes("google") || source.includes("gemini")) {
    return { monogram: "GE", gradientClass: VENDOR_GRADIENTS[3]! };
  }
  if (source.includes("qwen") || source.includes("alibaba")) {
    return { monogram: "QW", gradientClass: VENDOR_GRADIENTS[4]! };
  }

  const raw = (vendor?.trim() || modelId?.trim() || "AI").replace(/[^a-zA-Z0-9]/g, "");
  const monogram = (raw.slice(0, 2) || "AI").toUpperCase();
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return {
    monogram,
    gradientClass: VENDOR_GRADIENTS[hash % VENDOR_GRADIENTS.length]!,
  };
}

/** Format a token count into a compact context window badge (`128K`, `1M`). */
export function formatContextWindow(tokens: number | null | undefined): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

/** Format a model's declared input/output price without inventing missing numbers. */
export function formatModelPrice(model: MinihRouterModel): string | null {
  const input = model.price?.input?.trim() || null;
  const output = model.price?.output?.trim() || null;
  if (input && output) return `$${input} / $${output} · 1M`;
  if (input) return `$${input} · 1M`;
  if (output) return `$${output} · 1M`;
  return null;
}

function toPickerRow(model: MinihRouterModel, protocol?: DirectProtocol): PickerModelRow {
  return {
    model,
    ...(protocol ? { protocol } : {}),
    chips: capabilityChips(model),
    contextBadge: formatContextWindow(model.contextWindow),
    priceText: formatModelPrice(model),
  };
}

function groupByVendor(rows: readonly PickerModelRow[], fallbackVendor: string): PickerVendorGroup[] {
  const groups = new Map<string, PickerModelRow[]>();
  for (const row of rows) {
    const vendor = row.model.vendor.trim() || fallbackVendor;
    const list = groups.get(vendor);
    if (list) list.push(row);
    else groups.set(vendor, [row]);
  }
  return [...groups.entries()].map(([vendor, items]) => ({ vendor, rows: items }));
}

/**
 * Build the picker's grouped view for either `"chat"` or `"image"` mode from
 * the catalog classifier (`splitDirectModels` / `splitDirectImageModels`).
 */
export function buildPickerView(
  models: readonly MinihRouterModel[],
  mode: PickerMode,
  query: string,
  fallbackVendor = "Other",
): PickerView {
  const filtered = filterDirectModels(models, query);
  // Only what the gateway allows for this operation. Rows that cannot do it are
  // not listed at all: the sheet is a list of choices, not the whole catalog, and
  // image output is a per-model gateway declaration (see `modelCapability`).
  const usableRows =
    mode === "chat"
      ? splitDirectModels(filtered).usable.map((item) => toPickerRow(item.model, item.protocol))
      : splitDirectImageModels(filtered).usable.map((model) => toPickerRow(model));
  return { vendorGroups: groupByVendor(usableRows, fallbackVendor) };
}
