/**
 * Build-time environment variables this package reads (PR-5, PR-6).
 *
 * `vite/client` already types the standard entries; these are the project's own
 * and are listed here so a typo is a compile error rather than an `undefined`
 * at runtime.
 */
interface ImportMetaEnv {
  /** Native builds only: the Gateway origin baked into the app (§11.5). */
  readonly VITE_GATEWAY_ORIGIN?: string;
  /**
   * Native builds only: the app/bundle id sent with a push registration, so one
   * Gateway can serve more than one build (§11.6). Absent means the Gateway
   * accepts the registration without one.
   */
  readonly VITE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
