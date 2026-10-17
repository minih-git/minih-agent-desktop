#!/usr/bin/env node
/** Tests for the text-contrast guard's color math and sheet audit. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  compositeOver,
  mixOklab,
  parseColor,
  parseRules,
  parseAllDeclarations,
  auditSheets,
} from "./check-text-contrast.mjs";

const noVars = () => undefined;

test("wcag ratio matches reference values", () => {
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);
  assert.equal(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }), 1);
  // #767676 on white is the canonical lightest AA-passing gray (~4.54:1).
  assert.ok(contrastRatio({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 }) > 4.5);
  assert.ok(contrastRatio({ r: 119, g: 119, b: 119 }, { r: 255, g: 255, b: 255 }) < 4.55);
});

test("oklab mix toward transparent keeps hue, scales alpha", () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const mixed = mixOklab(white, 70, { r: 0, g: 0, b: 0, a: 0 }, 30);
  assert.ok(Math.abs(mixed.a - 0.7) < 1e-9);
  for (const channel of ["r", "g", "b"]) {
    assert.ok(Math.abs(mixed[channel] - 255) <= 1, `${channel} preserved, got ${mixed[channel]}`);
  }
});

test("oklab mix of two opaque colors interpolates", () => {
  const red = { r: 255, g: 0, b: 0, a: 1 };
  const blue = { r: 0, g: 0, b: 255, a: 1 };
  const mixed = mixOklab(red, 50, blue, 50);
  assert.equal(mixed.a, 1);
  assert.ok(mixed.g < 128, "purple midpoint keeps some red and blue, little green");
  assert.ok(mixed.r > 60 && mixed.b > 60);
});

test("compositeOver blends translucent ink over a surface", () => {
  const out = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  for (const channel of ["r", "g", "b"]) {
    assert.ok(Math.abs(out[channel] - 127.5) < 1);
  }
  assert.equal(out.a, 1);
});

test("parseColor resolves hex, keywords, var() and color-mix()", () => {
  assert.deepEqual(parseColor("#63a8f8", noVars), { r: 99, g: 168, b: 248, a: 1 });
  assert.deepEqual(parseColor("#fff8", noVars), { r: 255, g: 255, b: 255, a: Number.parseInt("88", 16) / 255 });
  assert.deepEqual(parseColor("transparent", noVars), { r: 0, g: 0, b: 0, a: 0 });
  const scope = new Map([["--ink", "#ffffff"]]);
  const resolveVar = (name) => scope.get(name);
  assert.deepEqual(parseColor("var(--ink)", resolveVar), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(
    parseColor("var(--missing, #101010)", resolveVar),
    { r: 16, g: 16, b: 16, a: 1 },
  );
  const mixed = parseColor("color-mix(in oklab, var(--ink) 70%, transparent)", resolveVar);
  assert.ok(Math.abs(mixed.a - 0.7) < 1e-6);
});

test("parseRules strips comments so header prose cannot masquerade as a selector", () => {
  const rules = parseRules("/* mentions :root[data-theme=\"light\"] in prose */\n:root { --a: #fff; }");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, ":root");
});

test("parseAllDeclarations returns regular properties too", () => {
  const decls = parseAllDeclarations("color: color-mix(in oklab, #fff 60%, transparent); --x: #000;");
  assert.deepEqual(decls, [
    ["color", "color-mix(in oklab, #fff 60%, transparent)"],
    ["--x", "#000"],
  ]);
});

const PASSING_SHEETS = {
  tokensCss: `
    :root {
      --ds-bg-primary: #181818;
      --ds-bg-secondary: #212121;
      --ds-tile: color-mix(in oklab, #ffffff 3.5%, transparent);
      --ds-text-primary: #ffffff;
      --ds-text-secondary: color-mix(in oklab, #ffffff 70%, transparent);
      --ds-text-muted: color-mix(in oklab, #ffffff 52%, transparent);
      --ds-text-faint: color-mix(in oklab, #ffffff 38%, transparent);
      --ds-prose-accent: #63a8f8;
      --ds-success: #40c977;
      --ds-warning: #ff8549;
      --ds-error: #ff6764;
      --ds-info: #afafaf;
      --ds-placeholder-ink: color-mix(in oklab, #ffffff 42%, transparent);
    }
    :root[data-theme="light"] {
      --ds-bg-primary: #ffffff;
      --ds-bg-secondary: #f9f9f9;
      --ds-text-primary: #1a1c1f;
      --ds-text-secondary: color-mix(in oklab, #1a1c1f 74%, transparent);
      --ds-text-muted: #5d5d5d;
      --ds-text-faint: #afafaf;
      --ds-prose-accent: #1c64c8;
      --ds-success: #00802f;
      --ds-warning: #c2410c;
      --ds-error: #d42a26;
      --ds-info: #5d5d5d;
      --ds-placeholder-ink: #4a4c4f;
    }
  `,
  proseCss: ".prose-chat a { color: var(--ds-prose-accent); }",
};

test("auditSheets passes the reference palette on both themes", () => {
  const findings = auditSheets(PASSING_SHEETS);
  const failures = findings.filter((f) => !f.ok);
  assert.deepEqual(failures.map((f) => f.target), []);
  assert.ok(findings.length >= 20, "audits every token against every surface in both themes");
});

test("auditSheets fails a quiet tier that dropped below the floor", () => {
  const sheets = {
    tokensCss: PASSING_SHEETS.tokensCss.replace("52%, transparent", "30%, transparent"),
    proseCss: PASSING_SHEETS.proseCss,
  };
  const failures = auditSheets(sheets).filter((f) => !f.ok && f.target === "--ds-text-muted");
  assert.ok(failures.length >= 3, "flagged on every dark surface");
  assert.ok(failures.every((f) => f.theme === "dark"));
});

test("auditSheets audits prose quiet-tier literals and honors decorative floors", () => {
  const sheets = {
    tokensCss: PASSING_SHEETS.tokensCss,
    proseCss: `
      :root[data-theme="light"] .prose-chat p { color: color-mix(in oklab, var(--ds-text-primary) 55%, transparent); }
      :root[data-theme="light"] .prose-chat li::marker { color: color-mix(in oklab, var(--ds-text-primary) 48%, transparent); }
    `,
  };
  const findings = auditSheets(sheets);
  const paragraph = findings.find((f) => f.target.includes(".prose-chat p"));
  const marker = findings.find((f) => f.target.includes("li::marker"));
  assert.equal(paragraph.ok, false, "55% ink on white is below the 4.5 informative floor");
  assert.equal(paragraph.floor, 4.5);
  assert.equal(marker.floor, 3.0, "decorative bullet glyph carries the documented lower floor");
});
