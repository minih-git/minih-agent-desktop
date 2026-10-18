# @minih-agent/remote-web

Browser ("H5") and native (Capacitor iOS / Android) client for a self-hosted
RACP Gateway (ADR 0331, decision D665).

A Vite + React single-page app that talks `RACP-HTTP` + SSE to a Gateway. The
browser build is served from the same origin as the Gateway it uses, which is
what lets the credential stay in an `HttpOnly` cookie and the CSP stay at
`connect-src 'self'`. The native builds load the same bundle from the app itself
and keep the device token in the iOS Keychain / Android Keystore.

Push notifications are **not** part of this package yet (PR-6).

## Commands

```sh
pnpm --filter @minih-agent/remote-web dev        # Vite dev server + Gateway proxy
pnpm --filter @minih-agent/remote-web build      # browser bundle in dist/
pnpm --filter @minih-agent/remote-web build:native  # Capacitor bundle (needs VITE_GATEWAY_ORIGIN)
pnpm --filter @minih-agent/remote-web cap:sync   # copy dist/ into ios/ and android/
pnpm --filter @minih-agent/remote-web typecheck
pnpm --filter @minih-agent/remote-web test       # pure-logic vitest suite (no DOM)
```

## Gateway wiring

* Host-scoped calls live under `/hosts/{hostId}`, so the client base URL is
  `/hosts/{hostId}` and the shared RACP-HTTP route table is used unchanged.
* The browser's device cookie is scoped to `Path=/hosts/{hostId}`, so
  `GET /v1/hosts` is deliberately not used: host status is probed with
  `GET /hosts/{hostId}/v1/sessions` (2xx online, 503 offline, 401 revoked).
* Pairing posts to `POST /v1/hosts/{hostId}/pair` with the pairing token in the
  `Authorization` header. The browser sends `client: "web"` and receives the
  `HttpOnly` device cookie plus a CSRF token in the body; a native build sends
  `client: "ios"` / `"android"` and receives the device token in the body.

### Development

`pnpm dev` proxies `/hosts` and `/v1` to `VITE_GATEWAY_ORIGIN`
(default `http://127.0.0.1:8788`) so the browser still sees one origin:

```sh
VITE_GATEWAY_ORIGIN=https://gateway.example.com pnpm --filter @minih-agent/remote-web dev
```

The Gateway must allow the dev origin (`--allowed-origin http://localhost:5173`),
because every cookie-authenticated request must carry an `Origin`.

Two dev-only notes: Vite injects its stylesheet and the React refresh preamble
inline, which the strict `index.html` CSP blocks; production builds are
unaffected. The Gateway must also serve the built `dist/` from the same origin.

## Building the iOS / Android apps

The operator builds the app for **their own** Gateway: there is no shared
binary and no account to sign up for. Signing identities, team ids, and
provisioning profiles stay on the operator's machine and are never committed.

1. Bake in the Gateway origin. It must be a bare https origin, and it becomes
   both the request base URL and the `connect-src` entry the native build's CSP
   carries. A native build without it fails at build time, and the app refuses
   to start rather than falling back to the webview's own origin.

   ```sh
   cd apps/remote-web
   VITE_GATEWAY_ORIGIN=https://gateway.example.com pnpm build:native
   ```

2. To ship under your own app id, change it in the native projects as well as
   in `capacitor.config.ts` — `cap sync` cannot do it: the Capacitor CLI writes
   the id only when a platform is added, so the committed projects hard-code
   `app.minih.remote`. Edit

   * the iOS bundle identifier (Xcode target → Signing & Capabilities, or
     `PRODUCT_BUNDLE_IDENTIFIER` in `ios/App/App.xcodeproj/project.pbxproj`,
     both the Debug and Release configuration),
   * `applicationId` in `android/app/build.gradle` (leave `namespace` and the
     `MainActivity` Java package alone unless you also move the package),
   * `appId` in `capacitor.config.ts`,

   so that the three agree — `src/lib/native-config.test.ts` fails when they
   drift apart. The display name is `appName` in `capacitor.config.ts`. Your own
   signing team / keystore is configured at the same time (step 3).

3. Copy the bundle into the native projects and open them:

   ```sh
   pnpm cap:sync
   open ios/App/App.xcodeproj          # then set your own signing team
   open -a "Android Studio" android    # then set your own applicationId/signing
   ```

   The iOS project uses Swift Package Manager (no CocoaPods). `xcodebuild
   -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk
   iphonesimulator CODE_SIGNING_ALLOWED=NO build` builds the simulator app, and
   `(cd android && ./gradlew assembleDebug)` builds the debug APK; the Android
   build needs `JAVA_HOME` (JDK 21) and `ANDROID_HOME` set.

4. Allow the webview origins on the Gateway. Every native request is
   cross-origin and carries the header profile, so the Gateway has to list the
   exact origins of both platforms (see `apps/remote-gateway/README.md`):

   ```sh
   --allowed-origin capacitor://localhost   # the only possible iOS webview origin
   --allowed-origin https://localhost       # the Android webview origin
   ```

5. Keep the release configuration https-only. `Info.plist` has no
   `NSAllowsArbitraryLoads` and no background or push mode; `AndroidManifest.xml`
   has `android:allowBackup="false"`, no `usesCleartextTraffic`, and asks for the
   internet permission only. `src/lib/native-config.test.ts` fails when any of
   these rules is broken.

Icons and splash screens are generated from the 1024×1024 mark in
`assets/logo.png` (the same file as `public/icon_1024.png`). This is a one-off,
so the tool is not a dependency — run it from `apps/remote-web` when the mark
changes, and commit the regenerated native resources:

```sh
npx --yes @capacitor/assets@3 generate \
  --iconBackgroundColor '#0b0f14' --splashBackgroundColor '#0b0f14' --splashBackgroundColorDark '#0b0f14'
```

It is deliberately not a workspace dependency: `@capacitor/assets` pins
`sharp@0.32.6`, whose install script downloads a native libvips binary, and
`allowBuilds` is workspace-wide — every install (CI, docs, release lanes) would
run it to serve an operation that happens once. The tool cache itself is never
committed.

## Secure storage

* The browser build keeps the device token in the Gateway's `HttpOnly` cookie
  and `localStorage` holds only `{hostId, label, deviceId, csrfToken, pairedAt}`.
* A native build writes the token to secure storage first and only then records
  the host, so a Host is never listed without a usable credential:
  * iOS: Keychain items are `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
    and iCloud sync is off, so a token never migrates to another device.
  * Android: the plugin keeps its AES key in the AndroidKeyStore, so the stored
    ciphertext is useless without this device's Keystore key — which is why
    `allowBackup` is false.
* The credentials are read into memory once at startup (`boot()` in
  `src/lib/runtime.ts`, awaited before the first render) because the screens
  need a synchronous `credentialFor()`.
* Keychain items survive an app reinstall while `localStorage` does not, so an
  item with no registry entry is deleted at startup (orphan cleanup), and a
  registry entry whose token is gone shows as "not paired" with a re-pairing
  prompt.
* Neither the pairing ticket nor any token is logged, put in a URL, or kept in
  memory after pairing.

## Layout

```
src/lib/            pure logic: ticket parsing, registry, credential ports,
                    secure-store port, host client, status probe, reconnect
                    policy, stream supervisor, timeline reducer, command
                    builders, CSP and Gateway-origin resolution
src/lib/native-*.ts Capacitor adapters, imported only by a native build
src/hooks/          React glue (session stream, host registry, host status)
src/screens/        pair, hosts, sessions, session timeline
src/components/     shell, timeline rows, approval/input cards, composer
src/locales/        own catalog for the nine shipped locales
ios/, android/      Capacitor native projects (SPM on iOS)
capacitor.config.ts app id, name, and webview origin scheme
```
