#!/usr/bin/env node
/**
 * Text-contrast guard (Codex parity, see docs/spec/04-ux/07-ui-design-system.md).
 *
 * Codex's TUI derives every muted tone from the painted surface and enforces a
 * WCAG floor (codex-rs/tui/src/style/contrast.rs, MIN_TEXT_CONTRAST = 4.5).
 * This script ports that discipline to the renderer token sheets:
 *
 *  - Every audited design token (--ds-text-*, status inks, prose accent) is
 *    resolved per theme, composited over the surfaces it can paint on
 *    (bg-primary, bg-secondary, tile-over-bg), and must keep its floor.
 *  - `color:` declarations in prose.css that mix toward `transparent` are
 *    resolved the same way, so quiet prose tiers cannot silently fall below
 *    the floor in one theme.
 *
 * Decorative ink (bullet markers, faint/disabled tiers, placeholder hints)
 * carries an explicit lower floor with a reason instead of being skipped.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesDir = join(root, "apps/desktop/src/styles");

/* ---------- color math (sRGB <-> oklab, WCAG luminance) ---------- */

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** rgba channels 0..255 + alpha 0..1 */
export function toOklab({ r, g, b, a }) {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    alpha: a,
  };
}

export function fromOklab({ L, a, b, alpha }) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return {
    r: Math.round(clamp01(linearToSrgb(lr)) * 255),
    g: Math.round(clamp01(linearToSrgb(lg)) * 255),
    b: Math.round(clamp01(linearToSrgb(lb)) * 255),
    a: clamp01(alpha),
  };
}

/** CSS color-mix(in oklab, A pA%, B pB%) with premultiplied alpha. */
export function mixOklab(colorA, percentA, colorB, percentB = 100 - percentA) {
  const total = percentA + percentB;
  const wA = total === 0 ? 0 : percentA / total;
  const wB = 1 - wA;
  const a = toOklab(colorA);
  const b = toOklab(colorB);
  const alpha = a.alpha * wA + b.alpha * wB;
  // transparent black premultiplies to zero channels; un-premultiply after.
  const mixed = {
    L: a.L * a.alpha * wA + b.L * b.alpha * wB,
    a: a.a * a.alpha * wA + b.a * b.alpha * wB,
    b: a.b * a.alpha * wA + b.b * b.alpha * wB,
    alpha,
  };
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return fromOklab({
    L: mixed.L / alpha,
    a: mixed.a / alpha,
    b: mixed.b / alpha,
    alpha,
  });
}

/** sRGB alpha compositing of a (possibly translucent) ink over a surface. */
export function compositeOver(ink, surface) {
  if (ink.a >= 1) return { r: ink.r, g: ink.g, b: ink.b, a: 1 };
  const a = ink.a;
  return {
    r: ink.r * a + surface.r * (1 - a),
    g: ink.g * a + surface.g * (1 - a),
    b: ink.b * a + surface.b * (1 - a),
    a: 1,
  };
}

export function wcagLuminance({ r, g, b }) {
  return (
    0.2126 * srgbToLinear(r / 255) +
    0.7152 * srgbToLinear(g / 255) +
    0.0722 * srgbToLinear(b / 255)
  );
}

export function contrastRatio(fg, bg) {
  const l1 = wcagLuminance(fg);
  const l2 = wcagLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* ---------- minimal CSS parsing ---------- */

const HEX = /^#([0-9a-f]{3,8})$/i;

export function parseColor(value, resolveVar) {
  let v = value.trim();
  // Resolve leading var() references (with optional fallback).
  let guard = 0;
  while (v.startsWith("var(") && guard++ < 32) {
    const inner = v.slice(4, v.lastIndexOf(")"));
    const comma = inner.indexOf(",");
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    const resolved = resolveVar(name);
    if (resolved !== undefined && resolved !== null) {
      v = resolved;
    } else if (fallback !== null) {
      v = fallback;
    } else {
      return null;
    }
  }
  const mixMatch = v.match(
    /^color-mix\(\s*in\s+oklab\s*,\s*(.+?)\s+(\d*\.?\d+)%\s*,\s*(.+?)\s*(?:(\d*\.?\d+)%)?\s*\)$/i,
  );
  if (mixMatch) {
    const a = parseColor(mixMatch[1], resolveVar);
    const b = parseColor(mixMatch[3], resolveVar);
    if (!a || !b) return null;
    return mixOklab(a, Number.parseFloat(mixMatch[2]), b, mixMatch[4] ? Number.parseFloat(mixMatch[4]) : undefined);
  }
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (v === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (v === "black") return { r: 0, g: 0, b: 0, a: 1 };
  const hex = v.match(HEX);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = v.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    return {
      r: Number.parseFloat(parts[0]),
      g: Number.parseFloat(parts[1]),
      b: Number.parseFloat(parts[2]),
      a: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
    };
  }
  return null;
}

/** Split a stylesheet into { selector, body } rules (brace-aware). */
export function parseRules(cssSource) {
  // Comments are not selectors: header prose can mention :root[data-theme=...].
  const css = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let depth = 0;
  let selector = "";
  let body = "";
  for (const ch of css) {
    if (ch === "{") {
      depth += 1;
      if (depth === 1) {
        selector = body;
        body = "";
        continue;
      }
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({ selector: selector.trim(), body });
        body = "";
        continue;
      }
    }
    body += ch;
  }
  return rules;
}

export function parseDeclarations(body) {
  const decls = new Map();
  for (const [name, value] of parseAllDeclarations(body)) {
    if (name.startsWith("--") && value) decls.set(name, value);
  }
  return decls;
}

/** All `prop: value;` pairs, including regular properties like `color:`. */
export function parseAllDeclarations(body) {
  const decls = [];
  for (const raw of body.split(";")) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const name = raw.slice(0, idx).trim();
    const value = raw
      .slice(idx + 1)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    if (name && value) decls.push([name, value]);
  }
  return decls;
}

/* ---------- sheet model ---------- */

function buildThemeScopes(tokensCss) {
  const scopes = { dark: new Map(), light: new Map() };
  for (const rule of parseRules(tokensCss)) {
    const decls = parseDeclarations(rule.body);
    if (decls.size === 0) continue;
    const isLight = rule.selector.includes('data-theme="light"');
    const isThemeBlock = rule.selector.includes(":root");
    const target = isLight ? scopes.light : isThemeBlock ? scopes.dark : null;
    if (!target) continue;
    for (const [name, value] of decls) {
      target.set(name, value);
    }
  }
  return scopes;
}

function resolverFor(scope) {
  const resolveVar = (name) => scope.get(name);
  return (value) => {
    if (value === undefined || value === null) return null;
    const color = parseColor(value, resolveVar);
    return color && color.a > 0 ? color : null;
  };
}

/* ---------- audit configuration ---------- */

/**
 * floor: minimum WCAG ratio for informative text (WCAG AA normal text).
 * Lower floors must carry a reason and only cover decorative tiers.
 */
const TOKEN_AUDIT = [
  { token: "--ds-text-primary", floor: 4.5 },
  { token: "--ds-text-secondary", floor: 4.5 },
  { token: "--ds-text-muted", floor: 4.5 },
  { token: "--ds-text-faint", floor: 2.0, reason: "placeholder/decorative ink only — WCAG exempts disabled controls and placeholders" },
  { token: "--ds-prose-accent", floor: 4.5 },
  { token: "--ds-success", floor: 4.5 },
  { token: "--ds-warning", floor: 4.5 },
  { token: "--ds-error", floor: 4.5 },
  { token: "--ds-info", floor: 4.5 },
  { token: "--ds-placeholder-ink", floor: 3.0, reason: "placeholder hint ink, replaced on input" },
];

/** prose.css selectors whose `color:` mixes toward transparent get a lower floor. */
const PROSE_SELECTOR_FLOORS = [
  { match: /.prose-chat li::marker/, floor: 3.0, reason: "decorative bullet glyph" },
];

const DEFAULT_TEXT_FLOOR = 4.5;

/* ---------- audit execution ---------- */

export function auditSheets({ tokensCss, proseCss }) {
  const scopes = buildThemeScopes(tokensCss);
  const findings = [];

  for (const theme of ["dark", "light"]) {
    const scope = scopes[theme];
    const resolve = resolverFor(scope);
    const surfaces = {
      "bg-primary": resolve(scope.get("--ds-bg-primary")),
      "bg-secondary": resolve(scope.get("--ds-bg-secondary")),
      tile: (() => {
        const tile = resolve(scope.get("--ds-tile"));
        const bg = resolve(scope.get("--ds-bg-primary"));
        if (!tile || !bg) return null;
        return compositeOver(tile, bg);
      })(),
    };

    for (const { token, floor, reason } of TOKEN_AUDIT) {
      const ink = resolve(scope.get(token));
      if (!ink) {
        findings.push({ theme, surface: "—", target: token, ratio: null, floor, ok: false, reason: "unresolvable token" });
        continue;
      }
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        if (!surface) continue;
        const ratio = contrastRatio(compositeOver(ink, surface), surface);
        const ok = ratio >= floor;
        findings.push({ theme, surface: surfaceName, target: token, ratio, floor, ok, reason });
      }
    }

    // prose.css quiet-tier literals: `color:` values that mix toward transparent.
    for (const rule of parseRules(proseCss)) {
      const isLightRule = rule.selector.includes('data-theme="light"');
      if ((theme === "light") !== isLightRule) continue;
      const ruleScope = isLightRule ? scope : scopes.dark;
      const ruleResolve = resolverFor(ruleScope);
      for (const [prop, value] of parseAllDeclarations(rule.body)) {
        if (prop !== "color" || !value.includes("color-mix(") || !value.includes("transparent")) continue;
        const ink = ruleResolve(value);
        if (!ink) continue;
        const override = PROSE_SELECTOR_FLOORS.find((f) => f.match.test(rule.selector));
        const floor = override ? override.floor : DEFAULT_TEXT_FLOOR;
        let worst = { ratio: Number.POSITIVE_INFINITY, surface: null };
        for (const [surfaceName, surface] of Object.entries(surfaces)) {
          if (!surface) continue;
          const ratio = contrastRatio(compositeOver(ink, surface), surface);
          if (ratio < worst.ratio) worst = { ratio, surface: surfaceName };
        }
        findings.push({
          theme,
          surface: worst.surface,
          target: `${rule.selector} { ${prop} }`,
          ratio: worst.ratio,
          floor,
          ok: worst.ratio >= floor,
          reason: override ? override.reason : undefined,
        });
      }
    }
  }
  return findings;
}

export function main() {
  const tokensCss = readFileSync(join(stylesDir, "tokens.css"), "utf8");
  const proseCss = readFileSync(join(stylesDir, "prose.css"), "utf8");
  const findings = auditSheets({ tokensCss, proseCss });
  const failures = findings.filter((f) => !f.ok);
  for (const f of findings) {
    const status = f.ok ? "ok  " : "FAIL";
    const ratio = f.ratio === null ? "unresolved" : f.ratio.toFixed(2);
    const reason = f.reason ? `  (${f.reason})` : "";
    console.log(`${status} ${f.theme.padEnd(5)} ${f.surface.padEnd(12)} ${ratio.padStart(6)}  ${f.target}${reason}`);
  }
  console.log(
    `\n${findings.length - failures.length}/${findings.length} checks passed (floor 4.5 = WCAG AA informative text)`,
  );
  if (failures.length > 0) {
    console.error(`\n${failures.length} text-contrast failure(s):`);
    for (const f of failures) {
      console.error(`  ${f.theme} ${f.target} on ${f.surface}: ${f.ratio?.toFixed(2) ?? "?"} < ${f.floor}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
