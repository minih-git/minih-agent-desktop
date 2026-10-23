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
  /**
   * Where this build's privacy policy is published. Absent means Settings shows
   * no privacy row at all, because the client cannot derive a URL for a
   * document that lives in the repository.
   */
  readonly VITE_PRIVACY_POLICY_URL?: string;
}

/**
 * The package version, injected by `define` in `vite.config.ts`. Declared here
 * so a typo is a compile error; a Node test run has no define and sees
 * `undefined`, which `lib/settings-view.ts` handles.
 */
declare const __APP_VERSION__: string;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
