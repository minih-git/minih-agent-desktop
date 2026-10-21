import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, nativeTheme } from "electron";
import { IPC } from "@minih-agent/shared";
import { MainProcessState } from "../../apps/desktop/electron/main/bootstrap/main-state";
import { createApplicationLifecycle } from "../../apps/desktop/electron/main/bootstrap/app-lifecycle";
import { registerWindowIpc } from "../../apps/desktop/electron/main/ipc/window-ipc";
import { createProviderCatalogRuntime } from "../../apps/desktop/electron/main/runtime/provider-catalog";

const temp = process.argv[2];
app.setPath("userData", join(temp, "profile"));
app.on("window-all-closed", () => {});

app.on("web-contents-created", (_event, contents) => contents.on("console-message", (event) => console.error(event.message)));
void app.whenReady().then(async () => {
try {
  const catalog = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });
  for (const value of [undefined, null, "false", 1, {}, []]) {
    assert.throws(() => catalog.validateSettingsWrite({ macosWindowTranslucency: value }), /macosWindowTranslucency/);
  }
  for (const value of [true, false]) catalog.validateSettingsWrite({ macosWindowTranslucency: value });
  const checks = [];
  for (const preference of [undefined, true, false]) {
    const state = new MainProcessState();
    const lifecycle = createApplicationLifecycle({
      state: state.windowLifecycleState,
      appState: state.applicationLifecycleState,
      appearanceState: state.applicationAppearanceState,
      dataDir: join(temp, "data"), isDevelopmentBuild: false,
      windowsAllowedToClose: state.windowsAllowedToClose,
      windowMinWidth: 640, windowMinHeight: 480, windowBoundsSettleMs: 100,
      workPanelNativeResizeSettleMs: 100,
      applyWorkPanelReservation: () => ({ width: 0, xOffset: 0 }),
      markWorkPanelChatResizeActive() {}, workPanelMinimumWindowWidth: () => 640,
      observedWorkPanelBaseBounds: (bounds) => bounds,
      classifyDisplayTransition: () => "none", sendToRenderer() {},
      safeOpenExternal: async () => {}, showPluginLauncher: async () => {},
      askCloseBehavior: async () => null, applyCloseBehavior() {},
      browserHost: { setWindow() {}, disposeGuest() {} }, pluginViews: { setWindow() {} },
      plugins: { getThemes: () => [], broadcastEvent() {} }, logger: { app() {} },
      refreshReleaseNotes() {}, applyPluginLauncherShortcut() {}, applyToggleWindowShortcut() {},
      broadcastPluginPanelEvent() {}, getHost: () => null, getRunningSessionIds: () => [],
    });
    assert.equal(state.macosWindowTranslucency, true, "unavailable settings must retain shipped default");
    lifecycle.applyMacosWindowTranslucency(preference === undefined ? undefined : { macosWindowTranslucency: preference });
    const applied = process.platform === "darwin" && preference !== false;
    assert.equal(state.macosWindowTranslucency, applied);
    lifecycle.applyNativeThemeSource({ theme: "light" });
    await lifecycle.createWindowForLifecycle();
    const window = state.mainWindow;
    const handlers = new Map();
    registerWindowIpc({
      registrar: {
        handle: (channel, fn) => handlers.set(channel, fn),
        handleWithEvent: (channel, fn) => handlers.set(channel, fn),
        assertMainWindowSender: (event) => assert.equal(event.sender, window.webContents),
      },
      getMainWindow: () => state.mainWindow, getWorkPanelReservationWidth: () => 0,
      setWorkPanelReservationWidth() {}, setWorkPanelReservation() {},
      getWorkPanelChatWidthSetter: () => null, applyCloseBehavior() {},
      getCloseBehavior: () => "quit", markMenuRendererReady: () => true,
      executeNativeMenuAction: lifecycle.executeNativeMenuAction,
      setTraySessionPreferences: async () => {},
      isMacosWindowTranslucent: () => state.macosWindowTranslucency,
    });
    const getState = () => handlers.get(IPC.invoke.windowControl)({ action: "getState" });
    assert.equal((await getState()).macosWindowTranslucency, applied);
    const background = (theme, color) => handlers.get(IPC.invoke.windowSetBackgroundColor)(
      { sender: window.webContents }, { theme, color },
    );
    for (const theme of ["dark", "light"]) {
      lifecycle.applyNativeThemeSource({ theme });
      const result = await background(theme);
      assert.equal(result.applied, !applied);
      const color = window.getBackgroundColor().toLowerCase();
      assert.equal(color, applied ? "#000000" : theme === "dark" ? "#181818" : "#ffffff");
    }
    const custom = await background("light", "#123456");
    assert.equal(custom.applied, !applied);
    assert.equal(window.getBackgroundColor().toLowerCase(), applied ? "#000000" : "#123456");
    const renderer = await window.webContents.executeJavaScript(`globalThis.upstreamReliabilityUiProbe(${applied})`);
    assert.equal(renderer.ok, true);
    assert.equal((await getState()).macosWindowTranslucency, applied, "saving must not change the running window surface");
    // getBackgroundColor reports RGB only. Constructor transparency is covered
    // by the surface-options tests; capture both real renderer themes here.
    if (process.env.PI_E2E_ARTIFACT_DIR) {
      await mkdir(process.env.PI_E2E_ARTIFACT_DIR, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await background(theme);
        await window.webContents.executeJavaScript(`document.documentElement.dataset.theme = "${theme}"; new Promise(requestAnimationFrame)`);
        await writeFile(join(process.env.PI_E2E_ARTIFACT_DIR, `upstream-ui-${String(preference)}-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
    checks.push({ preference: String(preference), applied, renderer: renderer.checks });
    window.destroy();
    lifecycle.disposePowerSaveBlockers();
    // The additive state is not applicable outside macOS, even if a stored or
    // default value happens to be true. Exercise the existing IPC handler only.
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      state.macosWindowTranslucency = true;
      assert.equal((await getState()).macosWindowTranslucency, false);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  }
  nativeTheme.themeSource = "system";
  console.log("UPSTREAM_RELIABILITY_UI " + JSON.stringify({ ok: true, platform: process.platform, checks }));
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
});
