import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en, zhCN } from "@minih-agent/i18n";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { Button } from "../../apps/desktop/src/components/ui";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { ToastVariant } from "../../apps/desktop/src/stores/app-state";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle() { await frame(); await frame(); }
function until(predicate: () => boolean, label: string) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve(); }
    });
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(label)); }, 5000);
  });
}
function reset() { flushSync(() => useAppStore.setState({ toasts: [] })); }
function notify(message: string, variant: ToastVariant = "info", duration?: number) {
  flushSync(() => useAppStore.getState().showToast(message, { variant, duration, sound: false }));
}
function messages() { return [...document.querySelectorAll(".toast-message")].map((node) => node.textContent); }
function dismiss(index = 0) {
  const button = document.querySelectorAll<HTMLButtonElement>(".toast-dismiss")[index];
  check(button, "Missing dismiss control");
  return button;
}
async function finishAnimations() {
  await settle();
  for (const animation of document.querySelector(".toast-viewport")?.getAnimations({ subtree: true }) ?? []) {
    animation.finish();
  }
  await settle();
}
function Demo() {
  return <main className="notification-demo">
    <p>MINIH AGENT · NOTIFICATIONS</p>
    <h1>右侧通知</h1>
    <p>成功与普通信息自动关闭；错误与警告保留，直到你关闭。</p>
    <div className="notification-demo-actions">
      <Button onClick={() => notify("AI 服务已保存", "success")}>保存成功</Button>
      <Button onClick={() => notify("连接失败：无法访问服务，请检查地址和网络。", "error")}>连接失败</Button>
      <Button onClick={() => notify(i18n.t("contextCompaction.longThreadWarning"), "warning")}>上下文提醒</Button>
      <Button onClick={() => notify("剪贴板内容已复制")}>普通信息</Button>
      <Button onClick={reset}>清空演示</Button>
    </div>
    <p>悬停或聚焦可暂停计时。通知内容可选中复制。</p>
    <ToastHost />
  </main>;
}

declare global {
  var notificationCardsReady: Promise<void>;
  var notificationCardsProbe: () => Promise<unknown>;
  var notificationLayoutProbe: () => Promise<unknown>;
  var notificationDemo: () => Promise<void>;
}

globalThis.notificationCardsReady = (async () => {
  await i18n.init({ lng: "zh-CN", fallbackLng: "en", resources: {
    en: { translation: en }, "zh-CN": { translation: zhCN },
  } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Demo /></I18nextProvider>));
  await until(() => Boolean(document.querySelector(".toast-viewport")), "Missing global host");
})();

globalThis.notificationCardsProbe = async () => {
  await globalThis.notificationCardsReady;
  reset();
  const browser: Window = window;
  const nativeSetTimeout = browser.setTimeout;
  const nativeClearTimeout = browser.clearTimeout;
  const nativeNow = Date.now;
  const timers = new Map<number, { callback: TimerHandler; delay: number }>();
  let sequence = -1; let now = 1000;
  browser.setTimeout = (callback, delay = 0) => {
    const id = sequence--; timers.set(id, { callback, delay }); return id;
  };
  browser.clearTimeout = (id) => {
    if (id === undefined || !timers.delete(id)) nativeClearTimeout(id);
  };
  Date.now = () => now;
  try {
    notify("Error stays", "error"); notify("Warning stays", "warning");
    check(timers.size === 0, "Errors or warnings started an automatic timer");
    notify("Saved", "success");
    check(Number(timers.size) === 1 && [...timers.values()][0]?.delay === 4000, "Success must expire after 4s");
    now += 1000;
    flushSync(() => dismiss().focus());
    check(![...timers.values()].some((timer) => timer.delay >= 1000), "Keyboard focus did not pause the success timer");
    now += 5000;
    flushSync(() => dismiss().blur());
    const timer = [...timers.entries()].find(([, entry]) => entry.delay >= 1000);
    check(timer?.[1].delay === 3000, "Resume lost the remaining time");
    timers.delete(timer[0]);
    check(typeof timer[1].callback === "function", "Timer callback is not executable");
    flushSync(() => { if (typeof timer[1].callback === "function") timer[1].callback(); });
    check(document.querySelector(".toast.success.closing"), "Success timer did not begin dismissal");
    check(document.querySelectorAll(".toast[role=alert]").length === 2, "Important notifications disappeared");
    reset();
    check(Number(timers.size) === 0, "Unmount leaked a countdown");
    notify("Information");
    check([...timers.values()][0]?.delay === 4000, "Info timer differs from success");
    reset();
    notify("Please answer", "info", 0);
    check(Number(timers.size) === 0, "Explicit sticky reminder started a timer");
    reset();
  } finally {
    browser.setTimeout = nativeSetTimeout; browser.clearTimeout = nativeClearTimeout; Date.now = nativeNow;
  }
  // Enter animation must start outside the right edge, not above the app.
  notify("Entering", "warning");
  await settle();
  const card = document.querySelector<HTMLElement>(".toast"); check(card, "Missing notification");
  const animation = card.getAnimations().find((item) => item instanceof CSSAnimation && item.animationName === "toast-in");
  check(animation?.effect instanceof KeyframeEffect, "Missing entry animation");
  check(String(animation.effect.getKeyframes()[0]?.transform).includes("translateX"), "Entry is not from the right");
  await finishAnimations();
  check(card.getAttribute("role") === "alert", "Warning must be announced as an alert");
  check(getComputedStyle(card.querySelector(".toast-message")!).whiteSpace === "pre-wrap", "Message line breaks are not preserved");
  const remembered = useAppStore.getState().toasts[0].id;
  for (let index = 0; index < 7; index++) notify(`Warning ${index}`, "warning");
  check(useAppStore.getState().toasts.some((item) => item.id === remembered), "New notifications evicted a sticky card");
  check(messages()[0] === "Warning 6", "Newest notification is not first in DOM");
  const newest = useAppStore.getState().toasts.at(-1)?.id;
  dismiss().click();
  await until(() => !useAppStore.getState().toasts.some((item) => item.id === newest), "Dismiss did not complete");
  check(useAppStore.getState().toasts.length === 7, "Dismiss removed unrelated notices");
  reset();
  for (const language of ["en", "zh-CN"]) {
    await i18n.changeLanguage(language);
    notify(i18n.t("contextCompaction.longThreadWarning"), "warning");
    await settle();
    check(dismiss().getAttribute("aria-label") === i18n.t("toast.dismiss"), "Dismiss is not localized");
    check(messages()[0] === i18n.t("contextCompaction.longThreadWarning"), "Notification copy changed at render time");
    reset();
  }
  return { ok: true, sticky: true, autoDismiss: true, focusPause: true, cleanup: true, rightEntry: true, retainedQueue: true, localized: true };
};

globalThis.notificationLayoutProbe = async () => {
  await globalThis.notificationCardsReady; reset();
  for (let index = 0; index < 9; index++) notify(`Warning ${index}: ${"Long notification text. ".repeat(8)}`, "warning");
  notify("错误详情：\n" + "服务不可用，请检查网络。".repeat(160), "error");
  await finishAnimations();
  const viewport = document.querySelector<HTMLElement>(".toast-viewport"); check(viewport, "Missing viewport");
  const rect = viewport.getBoundingClientRect();
  check(rect.x >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, "Notification stack escaped the viewport");
  check(Math.abs(innerWidth - rect.right - 16) <= 2 && rect.y >= 48, "Stack is not right-aligned below window controls");
  check(viewport.scrollHeight > viewport.clientHeight, "Sticky stack has no scrolling overflow");
  check(["auto", "scroll"].includes(getComputedStyle(viewport).overflowY), "Overflow cannot be scrolled");
  for (const button of document.querySelectorAll<HTMLButtonElement>(".toast-dismiss")) {
    button.scrollIntoView({ block: "nearest" }); await settle();
    const box = button.getBoundingClientRect();
    check(box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1, "A dismiss control is unreachable");
    check(box.left >= 0 && box.right <= innerWidth, "Dismiss clipped horizontally");
  }
  viewport.scrollTop = 0; await settle();
  const count = useAppStore.getState().toasts.length; dismiss().click();
  await until(() => useAppStore.getState().toasts.length === count - 1, "Reduced-motion/overflow dismissal failed");
  return { ok: true, width: innerWidth, height: innerHeight, overflowReachable: true };
};

globalThis.notificationDemo = async () => {
  await globalThis.notificationCardsReady; await i18n.changeLanguage("zh-CN"); reset();
  notify("连接失败：无法访问服务，请检查地址和网络。", "error");
  notify(i18n.t("contextCompaction.longThreadWarning"), "warning");
  await finishAnimations();
};
