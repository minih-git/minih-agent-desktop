import { createInstance } from "i18next";
import { en, zhCN } from "@minih-agent/i18n";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Mode } from "@minih-agent/shared";
import { ComposerModePicker } from "../../apps/desktop/src/features/chat/composer/ComposerModePicker";

const i18n = createInstance();
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

function Fixture() {
  const [mode, setMode] = useState<Mode>("agent");
  const [open, setOpen] = useState(false);
  return <div className="composer-toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <ComposerModePicker t={i18n.t} mode={mode} planningLive={false} open={open}
      setOpen={setOpen} controlsBlocked={false} onCloseOtherMenus={() => {}} onSelect={setMode} />
    <span data-neighbor>Model</span>
  </div>;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

declare global {
  var modeFontProbe: (language: string, scale: number, width: number) => Promise<unknown>;
}

globalThis.modeFontProbe = async (language, scale, width) => {
  if (!i18n.isInitialized) await i18n.init({
    lng: language, fallbackLng: "en", resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
  await i18n.changeLanguage(language);
  document.documentElement.style.setProperty("--font-scale", String(scale));
  document.documentElement.dataset.theme = "light";
  document.body.style.cssText = "padding:32px; margin:0;";
  host.style.cssText = `width:${width - 64}px; margin-top:240px;`;
  flushSync(() => root.render(<Fixture key={`${language}-${scale}-${width}`} />));
  await document.fonts.ready;
  await frame();
  const trigger = host.querySelector<HTMLButtonElement>(".composer-mode-chip");
  check(trigger, "mode trigger missing");
  const expectedWidth = 96 * scale;
  const states = [];
  let neighborX: number | undefined;
  for (const [index, mode] of ["agent", "plan", "goal"].entries()) {
    flushSync(() => trigger.click());
    await frame();
    await frame();
    const options = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    check(options.length === 3, "mode menu must contain three choices");
    flushSync(() => options[index].click());
    await frame();
    const animations = host.getAnimations({ subtree: true });
    await Promise.all(animations.map((animation) => animation.finished));
    check(trigger.dataset.mode === mode, `mode switch failed: ${mode}`);
    check(trigger.getAttribute("aria-expanded") === "false", "menu did not close");
    const label = host.querySelector<HTMLElement>(".composer-mode-chip-label");
    const neighbor = host.querySelector<HTMLElement>("[data-neighbor]");
    check(label && neighbor, "mode geometry missing");
    const rect = trigger.getBoundingClientRect();
    check(Math.abs(rect.width - expectedWidth) < 1, `width ${rect.width} differs from ${expectedWidth}`);
    check(label.scrollWidth <= label.clientWidth + 1, `label clipped: ${language}/${scale}/${mode}`);
    const x = neighbor.getBoundingClientRect().x;
    if (neighborX !== undefined) check(Math.abs(x - neighborX) < 1, "adjacent control moved on mode change");
    neighborX = x;
    check(host.scrollWidth <= host.clientWidth, "fixture toolbar overflow");
    states.push({ mode, label: label.textContent, width: rect.width, labelWidth: label.clientWidth });
  }
  return { language, scale, width, states };
};
