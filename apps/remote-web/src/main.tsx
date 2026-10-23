/**
 * Entry point (PR-4, PR-5).
 *
 * i18next is initialized before the first render so no screen can paint an
 * untranslated key, and the document language follows the resolved locale.
 *
 * A native shell starts in two steps: `boot()` attaches the platform secure
 * store and fills the device-token cache, and only then is the app rendered —
 * `credentialFor()` is synchronous, so no screen may run before the store is
 * ready. The runtime and `App` are imported dynamically inside the same
 * try/catch, because a native build with an unusable baked origin or an
 * unreachable Keychain must report the failure instead of painting a blank
 * webview.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";

import { BootFailure } from "./components/BootFailure.js";
import { initI18n } from "./lib/i18n.js";
import {
  DARK_SCHEME_QUERY,
  applyTheme,
  readThemePreference,
  resolveTheme,
  watchSystemTheme,
} from "./lib/theme.js";
import "./styles.css";

async function bootstrap(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) throw new Error("the app root element is missing");
  const darkQuery =
    typeof window.matchMedia === "function" ? window.matchMedia(DARK_SCHEME_QUERY) : null;
  applyTheme(document, resolveTheme(readThemePreference(), darkQuery?.matches ?? true));
  // The appearance follows the OS for the whole session: this used to be a
  // Settings-only listener, so the theme froze as soon as that screen closed.
  watchSystemTheme(document, darkQuery);
  await initI18n();
  document.documentElement.lang = i18n.language;
  const root = createRoot(container);
  try {
    const [{ boot, startDirectChatRuntime }, { default: App }] = await Promise.all([
      import("./lib/runtime.js"),
      import("./App.js"),
    ]);
    await boot();
    // Direct chat's own startup: a reply a previous process left live becomes
    // interrupted, and leaving the foreground interrupts from then on. Failure
    // here must not stop the remote side of the app from rendering.
    void startDirectChatRuntime().catch((error: unknown) => {
      console.warn("[remote-web] direct chat runtime did not start", error);
    });
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    root.render(
      <StrictMode>
        <BootFailure reason={reason} />
      </StrictMode>,
    );
  }
}

void bootstrap();
