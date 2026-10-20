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

## Account mode (D666, rollout R7 package F)

When the Gateway serves account mode (it was started with `--router-url` and
`--router-client-ip-header`, see `apps/remote-gateway/README.md`), this client
can sign in with the account's Minih-Router AccessKey, ask the account's
computers to approve ONE device, and then use that device on all of them.

* **Discovery.** `GET /v1/account/hosts` is probed once per Hosts screen, with no
  credential at all. `401` means the route exists and wants a session, so the
  AccessKey entry is offered; `404` (no account mode) and `403` (this origin is
  refused) keep the pairing flow and hide the entry; anything else, including a
  transport failure, keeps the pairing flow too, because an entry that cannot
  work is worse than no entry.
* **The AccessKey.** It is typed into a `type="password"` field with autofill
  off, presented once in the `Authorization` header of `POST /v1/account/login`,
  and dropped from the component on every outcome. It is never written to
  `localStorage`, `sessionStorage`, IndexedDB, a cookie, a native store, a URL,
  or a log. What the login leaves behind is an account *session* credential,
  which the client keeps in memory only.
* **Roster.** `POST /v1/account/devices` answers the account's whole Host roster
  immediately, with `canConfirm` and `willAcceptGrant` per Host, so a computer
  that cannot answer is named up front instead of being waited on. When none of
  them can confirm, the screen says so and offers the per-Host pairing ticket.
* **Waiting.** `GET /v1/account/devices/{requestId}` is polled every 2 s; a
  failed read backs off exponentially to 15 s, a `RATE_LIMITED` answer waits
  exactly as long as its `Retry-After` asked, and eight consecutive failures end
  the wait as a failure. The request's own deadline ends it too, without another
  read. Both `expired` and a `granted` answer whose token was already picked up
  (`tokenDelivered: false`, no token) let the user ask again under the same
  session; `NOT_FOUND` returns to sign-in. The cancel button stops the wait and
  keeps the session.
* **Where the device token lands.** In the browser it is one `HttpOnly` cookie
  per Host of the account, set by the Gateway together with `csrfTokens` in the
  body, and each registry entry carries only that CSRF value — exactly the shape
  a paired Host has, which is why every host-scoped screen works unchanged. A
  native build receives the token in the body and keeps it in the platform
  secure store (`NativeCredentialPort.adoptAccountDevice`), never in the
  registry.
* **Logout.** Once the device is stored the client revokes the account session
  with `POST /v1/account/logout`, because JavaScript cannot clear an `HttpOnly`
  cookie. The device token is a separate credential and is untouched.
* **Switching.** A device granted this way is accepted on every Host of the
  account, so the Host list doubles as a switcher: no pairing per computer. A
  Host that answers `401 HOST_UNAUTHORIZED` has not adopted the device yet, and
  the row offers the next step that can actually work:
  * a Host the roster reported as `online: true, willAcceptGrant: false`
    confirms every device itself and will never adopt the grant this client
    holds, so the row says "this computer confirms every device itself" and
    offers **Ask again** — a new request, approved on that computer, whose new
    device replaces the previous one on every Host of the account;
  * any other unready Host has simply not caught up, so the row offers a
    refresh, with the same new request as the fallback.

  `401 UNAUTHORIZED` is the other case, a credential that is gone, and the row
  says so.
* **Which Hosts a browser can reach.** The browser's device cookies are set for
  the Hosts of the account that exist when the grant is issued. A Host enrolled
  into the account later has no cookie in this browser and no registry entry, so
  it becomes reachable from here only after a new device request (or a pairing
  ticket for that Host). A native build is not affected: it holds one
  account-scoped token and addresses whichever Host id it likes.

## Sessions by project, and new sessions

The session screen leads with projects, the way the desktop sidebar does.

* **Headings.** `project/list` (viewer role, protocol §7.7) supplies the project
  names; `src/lib/session-groups.ts` turns the two lists into the groups the
  screen renders. A project's sessions are ordered by most recent activity
  (then newest created, then id), and the projects themselves are ordered by
  their most recent session — the same order the desktop sidebar uses. A
  project that holds no session is not shown, because an empty heading is
  something the user cannot act on.
* **Nothing disappears.** A session with no `projectId`, or with a project that
  is no longer in the catalog, lands in one trailing "Other" group. Archiving a
  project hides it from the new-session choice but not its history, so its
  sessions keep their project's name.
* **When `project/list` fails.** The list stays flat, every session falls under
  "Other", and an amber line says the project list could not be loaded. The
  screen never becomes unusable because a heading could not be read.
* **New session.** `session/create` (controller role, `POST /v1/sessions`) takes
  the *project id* the catalog named, not a path, which is exactly why
  `project/list` exists. `src/lib/mutations.ts` sends `projectId` and, only when
  it is not blank, a trimmed `title` — the rest of `SessionCreateParams` (mode,
  permission mode, provider, model) is left to the Host's own defaults rather
  than invented here. With one usable project the button goes straight to it;
  with several it asks which one, and archived projects are not offered at all.
  The created session opens on its composer, so the first message can be sent
  immediately.
* **Who may create.** The roles the Gateway granted the device are recorded in
  the registry entry when the device is paired **or adopted as an account
  device** (`src/lib/credential-port.ts`, `src/lib/native-credential-port.ts`),
  because `connection/initialize` has no RACP-HTTP mapping. Account adoption
  reads them from the grant's status answer and writes the same set on every
  Host of the account — one grant is one principal. A recorded absence of
  `controller` replaces the button with the reason; an entry written before that
  field existed is treated as unknown, so the button is offered and the Host's
  own `FORBIDDEN` is shown as itself.
* **Adding a project.** When the project the user wants is not in the list yet,
  **Add a project** opens the Host's folder picker (`project/browse`,
  controller role): it starts at the Host's browse root — the user's home
  directory — walks down a level at a time, and offers **Up** until it is back
  at the root. Picking a folder registers it (`project/register`) and opens a
  session in it, so the folder does not have to be created on the desktop first.
  Both operations are `controller`, and the Host confines them to that root: a
  `..` detour, a relative path, or a symlink pointing outside is refused with
  `REMOTE_PATH_FORBIDDEN`, and a directory that does not exist is reported as
  missing rather than created. Paths are *shown* from the root (`~/Projects/app`)
  so a phone screen never prints the account name; the request still carries the
  Host's own absolute spelling.
* **Known limit.** A browse answer carries at most 500 directories and has no
  "more" affordance, so a folder with more than 500 sub-folders shows only the
  first 500 (alphabetically). The root and every level are bounded the same way;
  filtering or search inside the picker is not implemented.
* **Which Hosts offer it.** A `controller` device may call all three operations;
  a `viewer`-only device may not, and the Host answers `FORBIDDEN`, which the
  screen shows as itself. A desktop must run a build that includes the A2 Host
  change; a self-hosted Gateway must be new enough to expose the two new routes
  (`POST /v1/projects`, `GET /v1/projects:browse`), otherwise the phone gets
  `NOT_FOUND` for them.

## Push notifications (native only)

The native app can receive the four notification-worthy events of protocol §11.6
— an approval or an input request is waiting, a turn completed or failed — as a
push. The browser build implements **no** Web Push: ADR 0331 decision 7 covers
the app, and the H5 client has nothing to register.

* **What arrives.** A fixed kind, two localization keys
  (`push.notify.<kind>.title` / `.body`, resolved from this package's own
  catalogs), and the Host, session, approval, and event ids. The Gateway never
  sends a sentence, a prompt, a tool name, or a transcript excerpt, so a
  notification cannot become a content channel.
* **Registration.** `src/hooks/usePushRegistration.ts` asks for permission
  once, registers with APNs or FCM, and hands the provider token to
  `PUT /v1/push/registration` with every device credential this phone holds: an
  account device is one credential that covers the whole account, while each
  §11.4 pairing is its own device and needs its own registration — a phone
  paired with three Hosts is reachable from all three. The token is never stored
  by this client — the platform holds it — and a Gateway without a configured
  provider answers `enabled: false`, which stops the client asking. A failed
  permission is final for that launch: nothing retries in a loop.
* **Forgetting a Host unregisters first.** `DELETE /v1/push/registration` needs
  the device token, so it is sent *before* the token is deleted
  (`src/lib/forget.ts`); an account device that still covers other Hosts keeps
  its registration until the last of them goes, and signing out unregisters too.
  A failed unregistration never blocks forgetting, but it is logged.
* **A tap** opens the Host and session the ids name; an unknown Host or a payload
  without ids opens the Host list. The payload's text is never rendered, only
  resolved as a key, which is why the notification can say "Needs your decision"
  in the user's language without the Gateway knowing it.
* **Operator material, never committed.** Two files belong to whoever builds the
  app, and neither ships in this repository (a test enforces that):

  1. **iOS**: enable the *Push Notifications* capability for your App ID in
     Xcode (target → Signing & Capabilities), which creates
     `ios/App/App/App.entitlements` with `aps-environment`. A build without it
     compiles and runs; it simply receives no notification. Ship the APNs `.p8`
     key — not this file — to the Gateway (`--apns-key-file`, see the Gateway
     README).
  2. **Android**: download `google-services.json` from your Firebase project and
     place it at `android/app/google-services.json` before
     `pnpm cap:sync`, and add the Google Services Gradle plugin to the app module
     as Firebase documents. Without it the app builds and runs and simply
     receives no notification. Ship the service-account JSON — not this file —
     to the Gateway (`--fcm-service-account-file`).

  `VITE_APP_ID` optionally tags a registration with the app id, so one Gateway
  can serve more than one build; absent, the Gateway accepts the registration
  without one.
* **The notification text is in the app bundle, not the JS catalog.** When the
  app is in the background or closed, the *system* renders the notification, so
  the eight keys also exist as `ios/App/App/en.lproj/Localizable.strings`,
  `ios/App/App/zh-Hans.lproj/Localizable.strings`,
  `android/app/src/main/res/values/strings.xml`, and
  `android/app/src/main/res/values-zh-rCN/strings.xml`. They are generated from
  `src/locales` and both files are committed:

  ```sh
  node scripts/generate-push-strings.mjs          # write
  node scripts/generate-push-strings.mjs --check  # verify, e.g. in CI
  ```

  `src/lib/push-strings.test.ts` fails when they are stale, and
  `src/lib/native-config.test.ts` proves the iOS file is in the app target (a
  `.strings` file outside the Xcode project ships nowhere). Adding a locale to
  the app means adding it here too, or that language falls back to the raw key.
* **Nothing background.** The client declares no `UIBackgroundModes`, no
  `aps-environment` in `Info.plist`, and no push-related Android permission
  beyond the internet one, because a notification here is an alert the user taps,
  never a silent data push. `src/lib/native-config.test.ts` keeps it that way.
  The notification *text* is the one thing that is committed: fixed copy, no
  content, generated from the catalogs as described above.

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
