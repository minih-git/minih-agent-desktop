#!/usr/bin/env node
/**
 * Isolated Desktop line for IMAP credentials over host-owned TCP.
 *
 * The real path, end to end:
 *
 *   plugin settings form (rendered by the app)
 *     → IPC `plugin/credentials/set` → host-core store (`plugins.credentials.set`)
 *   plugin command (runs in a forked sidecar)
 *     → `pi.net.tcp.connect({ endpoint, credentialRef })`
 *     → Electron main resolves the slot through host-core and logs in itself
 *     → `AUTHENTICATE PLAIN` over implicit TLS to the server this script owns
 *     → the plugin's own `A1 SELECT INBOX` is answered after authentication.
 *
 * The server presents the static test leaf the plugin tests already use, and
 * that CA is trusted only through `NODE_EXTRA_CA_CERTS` in the Electron process
 * environment — no plugin call and no manifest field can widen trust, and the
 * plugin directory this script writes carries no certificate material.
 *
 * Isolation: `HOME`, `XDG_*`, `--user-data-dir` and `MINIH_AGENT_DATA_DIR` all
 * point inside one scratch directory, so no user configuration, plugin state or
 * credential is read or written. No screenshots are produced.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer as createTlsServer } from "node:tls";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { repositoryRoot, resolveElectronBinary, scaledTimeout } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

const repo = repositoryRoot();
const hostBinary = resolveHostBinary();
const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "imap-credentials-e2e-"));
const dataDir = join(dir, "data");
const homeDir = join(dir, "home");
const profileDir = join(dir, "profile");
const pluginDir = join(dir, "plugin");
const tlsDir = join(dir, "tls");

const PLUGIN_ID = "test.imap-credentials";
const COMMAND_ID = "test.imap.probe";
const USERNAME = "synthetic-imap-user@example.test";
const PASSWORD = "synthetic-imap-password";
const MAILBOX = "INBOX";

/**
 * The PEM blocks live in the plugin test fixture, so there is exactly one test
 * PKI in the repository. Only the CA is written to disk (for Electron); the key
 * stays in this process. Nothing here is ever printed.
 */
function fixtureBlock(source, name) {
  const match = new RegExp("const " + name + " = `([\\s\\S]*?)`;").exec(source);
  if (!match) throw new Error(`test fixture is missing ${name}`);
  return match[1];
}

const fixture = readFileSync(join(repo, "apps/desktop/test/plugin-tcp-imap-login.test.mjs"), "utf8");
const ca = fixtureBlock(fixture, "TEST_CA");
const cert = fixtureBlock(fixture, "LOCALHOST_CERT");
const key = fixtureBlock(fixture, "LOCALHOST_KEY");

mkdirSync(join(dir, "plugin"), { recursive: true });
mkdirSync(join(dir, "tls"), { recursive: true, mode: 0o700 });
mkdirSync(dataDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
const caPath = join(tlsDir, "ca.pem");
writeFileSync(caPath, ca + "\n", { mode: 0o600 });

/** A real TLS IMAP server: greeting, AUTHENTICATE, SELECT. It records the wire. */
const imapLines = [];
const imapSockets = [];
const capabilities = ["IMAP4rev1", "AUTH=PLAIN", "SASL-IR"];
const imapServer = createTlsServer({ cert, key }, (socket) => {
  imapSockets.push(socket);
  socket.on("error", () => {});
  socket.write(`* OK [CAPABILITY ${capabilities.join(" ")}] ready\r\n`);
  let pending = "";
  socket.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let index = pending.indexOf("\r\n");
    while (index !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 2);
      imapLines.push(line);
      const command = /^(\S+) ([A-Za-z][A-Za-z0-9._-]*)(?: (.*))?$/.exec(line);
      const tag = command?.[1];
      const verb = command?.[2]?.toUpperCase();
      if (verb === "AUTHENTICATE") socket.write(`${tag} OK authenticated\r\n`);
      else if (verb === "SELECT") socket.write(`* 1 EXISTS\r\n${tag} OK SELECT completed\r\n`);
      else if (verb === "LOGOUT") socket.end(`* BYE logging out\r\n${tag} OK logout completed\r\n`);
      index = pending.indexOf("\r\n");
    }
  });
});

let child;
let ws;
let host;
let passed = false;
try {
  await new Promise((resolve, reject) => {
    imapServer.once("error", reject);
    imapServer.listen(0, "127.0.0.1", resolve);
  });
  const imapPort = imapServer.address().port;

  // The plugin owns the connection; the host owns the credential. The manifest
  // declares a literal endpoint, an IMAP slot and one command.
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: "IMAP 凭据测试插件",
    version: "1.0.0",
    main: "main.js",
    permissions: ["net.tcp", "credentials.use"],
    net: { tcp: [{ host: "127.0.0.1", port: imapPort, tls: true }] },
    contributes: {
      commands: [{ id: COMMAND_ID, title: "IMAP 连接测试" }],
      credentials: [{
        id: "mailbox",
        title: "测试邮箱",
        kind: "imap",
        fields: [
          { key: "username", label: "用户名" },
          { key: "password", label: "密码", secret: true },
        ],
        scope: { domains: ["127.0.0.1"] },
      }],
    },
  }, null, 2));
  writeFileSync(join(pluginDir, "main.js"), `module.exports = {
  async onLoad() {
    const waiters = [];
    const received = { text: "" };
    pi.events.on('net:tcp:data', (event) => {
      if (event?.data === undefined) return;
      received.text += Buffer.from(event.data).toString('utf8');
      for (const waiter of [...waiters]) {
        if (!received.text.includes(waiter.needle)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    });
    const waitText = (needle) => {
      if (received.text.includes(needle)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + needle)), 15000);
        waiters.push({ needle, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    };
    await pi.commands.register({
      id: '${COMMAND_ID}',
      title: 'IMAP 连接测试',
      run: async () => {
        const result = await pi.net.tcp.connect({
          endpoint: { host: '127.0.0.1', port: ${imapPort} },
          credentialRef: 'mailbox',
        });
        if (result.authenticated !== true) throw Error('the host did not authenticate the connection');
        await pi.net.tcp.send({ connectionId: result.connectionId, data: 'A1 SELECT ${MAILBOX}\\r\\n' });
        await waitText('A1 OK SELECT completed');
        if (!received.text.includes('* 1 EXISTS')) throw Error('SELECT answer missing');
        await pi.net.tcp.close({ connectionId: result.connectionId });
      },
    });
  },
};`);

  // The credential store lives in host-core; the app reads it from there.
  host = new Host(hostBinary, dataDir, { quiet: true });
  await host.start();
  await host.call("plugins.loadDev", { path: pluginDir });
  await host.call("settings.set", { language: "zh-CN", theme: "light" });
  await host.stop();

  const debugPort = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const value = probe.address().port;
      probe.close(() => resolve(value));
    });
  });
  const env = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    MINIH_AGENT_DATA_DIR: dataDir,
    MINIH_AGENT_HOST_BIN: hostBinary,
    MINIH_AGENT_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
    // The only trust anchor for this run; the plugin cannot set or widen it.
    NODE_EXTRA_CA_CERTS: caPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(resolveElectronBinary(repo).electronBinary,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, "."],
    { cwd: join(repo, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"] });
  // Drain child output without retaining potentially sensitive diagnostics.
  child.stdout.resume();
  child.stderr.resume();

  let target;
  await waitFor(async () => {
    try {
      target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json())
        .find((entry) => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
      return !!target;
    } catch { return false; }
  }, scaledTimeout(60_000), "isolated desktop target");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(detail);
    }
    return result.result.value;
  };
  const until = (expression, label) => waitFor(() => evaluate(expression), scaledTimeout(30_000), label);
  const click = async (selector) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    const clicked = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true})()`);
    if (!clicked) throw new Error(`cannot click ${selector}`);
  };

  await send("Page.enable");
  await until(`!!document.querySelector('[data-nav="plugins"]')`, "sidebar");
  await click('[data-nav="plugins"]');
  await until(
    `!![...document.querySelectorAll('.plugins-row')].find(e=>e.textContent.includes('IMAP 凭据测试插件'))`,
    "plugin row",
  );
  await evaluate(`(()=>{const row=[...document.querySelectorAll('.plugins-row')].find(e=>e.textContent.includes('IMAP 凭据测试插件'));const b=row?.querySelector('[aria-label="插件设置"]');if(!b)throw Error('settings button missing');b.click()})()`);
  await until(`!!document.querySelector('.plugin-credential-slot')`, "credential form");

  // Nothing is configured yet: the form must say so and refuse to clear.
  await until(`document.querySelector('.plugin-credential-slot').textContent.includes('未配置')`, "unconfigured state");
  const clearDisabled = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='清除凭据');return !!b && b.disabled})()`);
  if (!clearDisabled) throw new Error("clear must be disabled before anything is saved");

  // Save the synthetic IMAP credential through the settings form itself.
  const fieldSelector = (label) => `input[aria-label=${JSON.stringify(label)}]`;
  const fill = async (label, value) => {
    const selector = JSON.stringify(fieldSelector(label));
    const ok = await evaluate(`(()=>{const e=document.querySelector(${selector});if(!e)return false;e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    if (!ok) throw new Error(`input not found: ${label}`);
  };
  await fill("用户名", USERNAME);
  await fill("密码", PASSWORD);
  const passwordMasked = await evaluate(`document.querySelector(${JSON.stringify(fieldSelector("密码"))}).type`);
  if (passwordMasked !== "password") throw new Error("the password field must be masked");
  const saveEnabled = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存凭据');return !!b && !b.disabled})()`);
  if (!saveEnabled) throw new Error("save must be enabled once every field is filled");
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存凭据');if(!b||b.disabled)throw Error('save unavailable');b.click()})()`);
  await until(`document.querySelector('.plugin-credential-slot').textContent.includes('已配置')`, "configured state");
  for (const label of ["用户名", "密码"]) {
    const value = await evaluate(`document.querySelector(${JSON.stringify(fieldSelector(label))}).value`);
    if (value) throw new Error(`the saved ${label} field must be cleared`);
  }

  // Run the plugin's own command; it connects, authenticates, then SELECTs.
  await until(`(async()=>{const r=await window.minihAgent.invoke(window.minihAgent.channels.invoke.commandPaletteSearch,'IMAP 连接测试');return r.ok&&r.data.commands.some(c=>c.id===${JSON.stringify(COMMAND_ID)})})()`, "plugin command");
  const commandResult = await evaluate(`(async()=>{const r=await window.minihAgent.invoke(window.minihAgent.channels.invoke.commandPaletteExecute,${JSON.stringify(COMMAND_ID)});return r.ok})()`);
  if (!commandResult) {
    const pluginLog = readFileSync(join(dataDir, "logs/app/plugin.log"), "utf8");
    throw new Error("the plugin command failed; last plugin log lines:\n" + pluginLog.trim().split("\n").slice(-5).join("\n"));
  }

  // The server saw exactly the host's login, then the plugin's own command.
  const authenticate = imapLines
    .map((line, index) => ({ line, index, match: /^\S+ AUTHENTICATE PLAIN (\S+)$/.exec(line) }))
    .filter((entry) => entry.match);
  if (authenticate.length !== 1) throw new Error(`one AUTHENTICATE PLAIN expected, saw ${JSON.stringify(imapLines.map((line) => line.replace(/ PLAIN \S+$/, " PLAIN <redacted>")))}`);
  const payload = Buffer.from(authenticate[0].match[1], "base64").toString("utf8");
  if (payload !== `\u0000${USERNAME}\u0000${PASSWORD}`) throw new Error("the wire credential is not the one saved in settings");
  if (imapLines.some((line) => /^\S+ LOGIN(?: |$)/.test(line))) throw new Error("LOGIN must not be used while AUTH=PLAIN is offered");
  const select = imapLines
    .map((line, index) => ({ line, index, match: new RegExp(`^\\S+ SELECT ${MAILBOX}$`).exec(line) }))
    .find((entry) => entry.match);
  if (!select) throw new Error(`the plugin's SELECT never reached the server: ${JSON.stringify(imapLines.map((line) => line.replace(/ PLAIN \S+$/, " PLAIN <redacted>")))}`);
  if (select.index < authenticate[0].index) throw new Error("SELECT was sent before the host authenticated");

  // The audit names the slot and the scheme, and never the credential.
  const auditLog = readFileSync(join(dataDir, "logs/app/plugin.log"), "utf8");
  const auditRows = auditLog.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const connectAudit = auditRows.find((row) => row.api === "net.tcp.connect" && row.ok === true);
  if (!connectAudit) throw new Error("a successful TCP connect was not audited");
  // The audit sink redacts a field named `credential`, so the slot id may only
  // appear as a redaction marker; a raw value here would be the failure.
  const auditedSlot = String(connectAudit.credential ?? "");
  if (auditedSlot && !/^\*+REDACTED\*+$/.test(auditedSlot)) {
    throw new Error(`audit slot field is neither absent nor redacted: ${JSON.stringify(connectAudit)}`);
  }
  if (connectAudit.scheme !== "imaps") throw new Error(`audit scheme mismatch: ${JSON.stringify(connectAudit)}`);
  if (connectAudit.host !== "127.0.0.1" || connectAudit.port !== imapPort) throw new Error(`audit endpoint mismatch: ${JSON.stringify(connectAudit)}`);
  for (const secret of [USERNAME, PASSWORD, authenticate[0].match[1]]) {
    if (auditLog.includes(secret)) throw new Error("a credential value reached the plugin audit log");
  }

  passed = true;
  console.log(`PASS isolated Desktop IMAP credential path (endpoint 127.0.0.1:${imapPort}, slot mailbox, audit scheme imaps)`);
} catch (error) {
  console.error(`FAIL ${error?.stack ?? error}`);
  console.error(`scratch kept for diagnosis: ${dir}`);
  process.exitCode = 1;
} finally {
  if (ws) {
    try { ws.close(); } catch { /* already gone */ }
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, scaledTimeout(5_000)))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  if (host) await host.stop();
  for (const socket of imapSockets) socket.destroy();
  await new Promise((resolve) => imapServer.close(resolve));
  if (passed) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}