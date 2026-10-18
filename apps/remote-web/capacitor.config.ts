/**
 * Capacitor shell configuration for the native builds (PR-5).
 *
 * `appId` is a literal, not an environment override: the Capacitor CLI writes
 * the app id into the native projects only when a platform is added (`cap add`
 * calls `editProjectSettingsIOS` / `editProjectSettingsAndroid`), and `cap sync`
 * never touches them. The committed projects therefore hard-code
 * `app.minih.remote` — the iOS `PRODUCT_BUNDLE_IDENTIFIER`, the Android
 * `applicationId`, and the `MainActivity` package. An operator who wants their
 * own id changes it in the native projects and here so all of them agree; see
 * `README.md`, and `src/lib/native-config.test.ts`, which fails when they drift
 * apart. Signing identities, team ids, and provisioning profiles stay outside
 * the repository.
 *
 * The webview bundle is served from the app itself, never from a remote URL:
 * no `server.url`, no `cleartext`, and `androidScheme` keeps the https origin
 * (`https://localhost`) the Gateway allowlists with
 * `--allowed-origin https://localhost`. iOS uses the default `capacitor://`
 * scheme, whose origin is `capacitor://localhost`. `ios.contentInset` stays
 * default because the layout already applies `env(safe-area-inset-*)`.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.minih.remote",
  appName: "Minih Remote",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
