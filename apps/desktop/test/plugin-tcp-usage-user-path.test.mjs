import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const desktop = join(root, "apps/desktop");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("opening plugin details fetches fresh TCP usage, reopening fetches again", async (t) => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "tcp-usage-ui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import i18n from "i18next";
    import { initReactI18next } from "react-i18next";
    import { PluginRowDetails } from ${JSON.stringify(join(desktop, "src/features/plugins/presentation.tsx"))};
    let calls = 0;
    window.fetchTcpUsage = async () => {
      calls++;
      const row = {host:"mail.example", port:993, bytesIn:calls === 1 ? 12 : 34, bytesOut:2};
      return {today:{endpoints:[row]}, last7Days:{endpoints:[row]}};
    };
    const ready = i18n.use(initReactI18next).init({ lng:"en", resources:{en:{translation:{plugins:{
      details:"Details", viewDetailsOf:"Details for {{name}}", permissionsTitle:"Permissions",
      tcpUsage:"TCP traffic", tcpUsageLoading:"Loading", tcpUsageToday:"Today",
      tcpUsageWeek:"Last 7 days", tcpUsageReceived:"Received", tcpUsageSent:"Sent"
    }}}}, interpolation:{escapeValue:false} });
    const frame = () => new Promise(requestAnimationFrame);
    async function waitFor(predicate, label) {
      for (let i=0;i<120;i++) { if (predicate()) return; await frame(); }
      throw new Error(label);
    }
    window.runProbe = async () => {
      await ready;
      createRoot(document.getElementById("root")).render(React.createElement(PluginRowDetails, {
        plugin:{id:"fixture.tcp", name:"Fixture", permissions:["net.tcp"]}, services:[]
      }));
      await waitFor(() => document.querySelector("summary"), "details missing");
      if (calls !== 0) throw new Error("collapsed details fetched traffic");
      document.querySelector("summary").click();
      await waitFor(() => document.querySelector("section")?.textContent.includes("12 B"), "first traffic missing");
      if (calls !== 1) throw new Error("first open did not fetch once");
      document.querySelector("summary").click();
      await waitFor(() => !document.querySelector("section"), "closed details retained traffic view");
      document.querySelector("summary").click();
      await waitFor(() => document.querySelector("section")?.textContent.includes("34 B"), "reopen did not refresh");
      if (calls !== 2) throw new Error("reopen did not fetch again");
      return "TCP_USAGE_UI_OK";
    };
  `;
  await build({
    stdin: { contents: source, resolveDir: desktop, loader: "tsx" },
    outfile: join(dir, "renderer.js"), bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", supported: { "top-level-await": true },
    alias: { react: join(desktop, "node_modules/react"), "react-dom": join(desktop, "node_modules/react-dom") },
    nodePaths: [join(desktop, "node_modules")],
    plugins: [{ name: "tcp-usage-fixture-api", setup(builder) {
      builder.onResolve({ filter: /lib\/api$/ }, (args) => args.importer.endsWith("PluginTcpUsage.tsx")
        ? { path: "fixture-api", namespace: "tcp-usage-fixture" } : null);
      builder.onLoad({ filter: /.*/, namespace: "tcp-usage-fixture" }, () => ({
        contents: "export const api = { getPluginTcpUsage: () => window.fetchTcpUsage() };", loader: "js",
      }));
    } }],
  });
  await writeFile(join(dir, "index.html"), '<!doctype html><div id="root"></div><script src="renderer.js"></script>');
  await writeFile(join(dir, "main.cjs"), `
    const {app, BrowserWindow} = require('electron');
    const path = require('node:path');
    app.setPath('userData', path.join(__dirname, 'profile'));
    app.disableHardwareAcceleration();
    app.whenReady().then(async () => {
      try {
        const win = new BrowserWindow({show:false, webPreferences:{sandbox:true, contextIsolation:true, backgroundThrottling:false}});
        await win.loadFile(path.join(__dirname, 'index.html'));
        console.log(await win.webContents.executeJavaScript('window.runProbe()'));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });
  `);
  const run = spawnSync(resolveElectronBinary(root).electronBinary, [join(dir, "main.cjs")], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /TCP_USAGE_UI_OK/);
});
