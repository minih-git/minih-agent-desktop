/**
 * Entry point (PR-4).
 *
 * i18next is initialized before the first render so no screen can paint an
 * untranslated key, and the document language follows the resolved locale.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";

import App from "./App.js";
import { initI18n } from "./lib/i18n.js";
import "./styles.css";

async function bootstrap(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) throw new Error("the app root element is missing");
  await initI18n();
  document.documentElement.lang = i18n.language;
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
