import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const LOCALES = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"];

const [capsule, shared, assistantTurn, css, ...localeCatalogs] = await Promise.all([
  read("../src/features/chat/transcript/TurnUsageCapsule.tsx"),
  read("../src/features/chat/transcript/shared.tsx"),
  read("../src/features/chat/transcript/AssistantTurn.tsx"),
  read("../src/styles/messages.css"),
  ...LOCALES.map((locale) =>
    read(`../../../packages/i18n/src/locales/${locale}/index.ts`),
  ),
]);

test("MessageMeta places the capsule immediately after the model chip and retains duration/steps/tools", () => {
  const modelChip = shared.indexOf("message-meta-chip model");
  const capsuleUsage = shared.indexOf("<TurnUsageCapsule");
  const durationChip = shared.indexOf("message-meta-chip duration");
  const stepsChip = shared.indexOf("message-meta-chip steps");
  assert.ok(modelChip > -1, "the model chip is still rendered");
  assert.ok(capsuleUsage > modelChip, "the capsule follows the model chip");
  assert.ok(durationChip > capsuleUsage, "duration metadata remains after the capsule");
  assert.ok(stepsChip > durationChip, "steps and tools metadata remain after duration");
  assert.match(
    shared,
    /message-meta-chip model[\s\S]{0,400}?<TurnUsageCapsule/,
  );
  assert.doesNotMatch(shared, /<TurnUsageCapsule[\s\S]{0,200}?message-meta-chip model/);
  assert.match(assistantTurn, /responseOutputEstimated=\{summary\.responseOutputEstimated\}/);
  assert.match(assistantTurn, /steps=\{steps\}/);
  assert.match(assistantTurn, /tools=\{summary\.tools\.length\}/);
});

test("the capsule renders only from turn usage and replaces the legacy chip", () => {
  assert.match(shared, /turnUsageBreakdown\(usage\)\.totalTokens > 0/);
  assert.match(shared, /usage && showTurnUsage/);
  assert.match(shared, /responseOutputEstimated/);
  assert.match(shared, /estimated=\{responseOutputEstimated\}/);
  assert.match(capsule, /estimated\s*\?/);
  assert.match(capsule, /chat\.usageThroughputEstimated/);
  assert.match(shared, /const showThroughput = !usage && throughput !== undefined/);
  assert.match(shared, /showThroughput \? \(/);
  assert.match(shared, /!modelId && !showThroughput && !showTurnUsage && !durationLabel && !steps/);
});

test("the capsule wires hover, focus, grace close, Escape, outside press, and session change", () => {
  assert.match(capsule, /const CLOSE_DELAY_MS = 120/);
  assert.match(capsule, /onPointerEnter/);
  assert.match(capsule, /onPointerLeave/);
  assert.match(capsule, /onFocus=\{openPopover\}/);
  assert.match(capsule, /onBlur=\{scheduleClose\}/);
  assert.match(capsule, /onClick=\{openPopover\}/);
  assert.match(capsule, /overTriggerRef\.current/);
  assert.match(capsule, /overPanelRef\.current/);
  assert.match(capsule, /document\.activeElement === triggerRef\.current/);
  assert.match(capsule, /event\.key !== "Escape"/);
  assert.match(capsule, /window\.setTimeout\(/);
  assert.match(
    capsule,
    /addEventListener\("pointerdown", handlePointerDown, true\)/,
  );
  assert.match(capsule, /\[activeSessionId, cancelClose\]/);
});

test("the popover portals to body, prefers upward placement, and clamps to the conversation pane", () => {
  assert.match(capsule, /useId\(\)/);
  assert.match(capsule, /portalToBody\(popover\)/);
  assert.match(capsule, /placeContextInspector\(\{/);
  assert.doesNotMatch(capsule, /prefer:/);
  assert.match(capsule, /closest\("\.main-pane"\)/);
  assert.match(capsule, /new ResizeObserver\(updatePosition\)/);
  assert.match(capsule, /addEventListener\("scroll", handleViewportChange, true\)/);
  assert.match(capsule, /addEventListener\("resize", handleViewportChange\)/);
  assert.match(capsule, /triggerRect\.bottom <= 0/);
  assert.match(capsule, /const popover = open \?/);
});

test("the capsule exposes dialog semantics and an accessible turn summary", () => {
  assert.match(capsule, /aria-haspopup="dialog"/);
  assert.match(capsule, /aria-expanded=\{open\}/);
  assert.match(capsule, /aria-controls=\{open \? panelId : undefined\}/);
  assert.match(capsule, /aria-label=\{t\("chat\.usageTurnAria"/);
  assert.match(capsule, /role="dialog"/);
  assert.match(capsule, /aria-label=\{t\("chat\.usageTurnTotal"\)\}/);
  assert.match(capsule, /aria-hidden="true"/);
  assert.match(capsule, /new Intl\.NumberFormat\(i18n\.language\)/);
  assert.match(capsule, /formatCompactTokenCount/);
});

test("the composition omits empty segments and keeps cache write conditional", () => {
  assert.match(capsule, /filter\(\(segment\) => segment\.tokens > 0\)/);
  assert.match(capsule, /className=\{`turn-usage-seg \$\{segment\.key\}`\}/);
  assert.match(capsule, /style=\{\{ flexGrow: segment\.tokens \}\}/);
  assert.match(capsule, /breakdown\.cacheWriteTokens > 0 \?/);
  assert.match(capsule, /className="turn-usage-bar"/);
});

test("the capsule styles use surface tokens and match the meta chip height", () => {
  const capsuleRule = css.match(/\.turn-usage-capsule \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(capsuleRule, /min-height: 20px/);
  assert.match(capsuleRule, /padding: 0 8px/);
  assert.match(capsuleRule, /gap: 6px/);
  assert.match(capsuleRule, /font-size: var\(--text-xs\)/);
  assert.match(capsuleRule, /line-height: var\(--leading-compact\)/);
  assert.match(capsuleRule, /font-variant-numeric: tabular-nums/);
  assert.match(capsuleRule, /white-space: nowrap/);
  assert.match(capsuleRule, /max-width: 100%/);
  assert.match(capsuleRule, /background: var\(--ds-tile\)/);

  const hoverRule =
    css.match(
      /\.turn-usage-capsule:hover,\n\.turn-usage-capsule\[data-open="true"\] \{[\s\S]*?\n\}/,
    )?.[0] ?? "";
  assert.match(hoverRule, /background: var\(--ds-tile-hover\)/);
  assert.match(hoverRule, /inset 0 0 0 1px var\(--ds-border-subtle\)/);

  const barRule = css.match(/\.turn-usage-bar \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(barRule, /width: 36px/);
  assert.match(barRule, /height: 4px/);

  const segmentRule = css.match(/\.turn-usage-seg \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(segmentRule, /flex-basis: 0/);
  for (const key of ["cache", "input", "output", "write"]) {
    assert.match(css, new RegExp(`\\.turn-usage-seg\\.${key} \\{`));
  }
  for (const key of ["cache", "input", "output", "write"]) {
    assert.match(
      css,
      new RegExp(
        `\\.turn-usage-seg\\.${key} \\{\\s*background: color-mix\\(in oklab, var\\(--ds-text-primary\\)`,
      ),
    );
  }

  const popoverRule =
    css.match(/\.turn-usage-popover \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(popoverRule, /position: fixed/);
  assert.match(popoverRule, /z-index: 60/);
  assert.match(popoverRule, /width: min\(268px, calc\(100vw - 32px\)\)/);
  assert.match(popoverRule, /background: var\(--ds-bg-elevated-opaque\)/);
  assert.match(popoverRule, /border: 1px solid var\(--ds-border-default\)/);
  assert.match(popoverRule, /border-radius: var\(--radius-md-plus\)/);
  assert.match(popoverRule, /padding: 12px/);
  assert.match(popoverRule, /box-shadow: var\(--ds-shadow-dialog\)/);
  assert.match(css, /\.turn-usage-popover\.is-open \{/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.turn-usage-capsule,\s*\.turn-usage-popover \{\s*transition: none;/,
  );

  const newBlock = css.slice(
    css.indexOf(".turn-usage-capsule {"),
    css.indexOf(".context-inspector {"),
  );
  assert.doesNotMatch(newBlock, /#[\da-f]{3,8}\b/i);
});

test("every locale adds the turn aria label and total label exactly once", () => {
  for (const [index, locale] of LOCALES.entries()) {
    const source = localeCatalogs[index];
    assert.equal(
      (source.match(/"?usageTurnAria"?\s*:/g) ?? []).length,
      1,
      `${locale} defines usageTurnAria once`,
    );
    assert.equal(
      (source.match(/"?usageTotal"?\s*:/g) ?? []).length,
      1,
      `${locale} defines usageTotal once`,
    );
    assert.match(
      source,
      /"?usageTurnAria"?\s*:\s*"[^"]*\{\{speed\}\}[^"]*\{\{count\}\}[^"]*"/,
      `${locale} keeps speed and count placeholders`,
    );
  }
});

test("MessageMeta renders TurnUsageCapsule beside model, duration, steps, and tools", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const { catalogs } = await import("@minih-agent/i18n");
  const { createServer } = await import("vite");
  const { fileURLToPath } = await import("node:url");

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    resolve: {
      alias: {
        "@minih-agent/plugin-sdk": fileURLToPath(
          new URL("../../../packages/plugin-sdk/src/index.ts", import.meta.url),
        ),
      },
    },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { MessageMeta } = await server.ssrLoadModule(
      "/src/features/chat/transcript/shared.tsx",
    );
    const i18n = createInstance();
    const enCatalog = {
      ...catalogs.en,
      chat: {
        ...catalogs.en.chat,
        usageTurnAria: "This turn: {{speed}}, {{count}} tokens. Show breakdown.",
        usageTotal: "Total",
      },
    };
    await i18n.init({ lng: "en", resources: { en: { translation: enCatalog } } });

    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(MessageMeta, {
          modelId: "gpt-5.4",
          usage: {
            inputTokens: 1_200,
            outputTokens: 600,
            cacheReadTokens: 3_000,
            reasoningTokens: 200,
            totalTokens: 99_999,
          },
          responseDurationMs: 2_000,
          responseOutputTokens: 600,
          durationLabel: "4s",
          steps: 3,
          tools: 2,
        }),
      ),
    );

    assert.match(html, /class="message-meta-chip model"[^>]*>gpt-5\.4<\/span>/);
    assert.match(html, /class="[^"]*\bturn-usage-capsule\b[^"]*"/);
    assert.match(html, /class="turn-usage-speed">300 tokens\/s<\/span>/);
    assert.match(html, /class="turn-usage-total">4\.8K<\/span>/);
    assert.match(html, /class="message-meta-chip duration">Took 4s<\/span>/);
    assert.match(html, /class="message-meta-chip steps">3 steps<span aria-hidden="true"> · <\/span>2 tools<\/span>/);
  } finally {
    await server.close();
  }
});
