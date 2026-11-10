import assert from "node:assert/strict";
import test from "node:test";
import * as sidebar from "../src/lib/sidebar-preferences.ts";

const key = "pi.desktop.sidebarPreferences";
const preferences = (paths = ["/work/alpha", "/work/beta"]) => ({
  sessionMeta: { conversation: { pinned: true, manualTitle: true } },
  projectMeta: { "/work/alpha": { name: "Alpha", collapsed: true, order: 1 } },
  projectSort: "manual", sessionView: { sort: "recent", archived: false },
  openProjectPaths: paths,
});

function fixture(t, { local, backup = null, projects = [] } = {}) {
  const values = new Map(local === undefined ? [] : [[key, JSON.stringify(local)]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const writes = [];
  const port = { read: async () => backup, write: async value => { writes.push(value); },
    listProjects: async () => ({ projects: projects.map(path => ({ path })) }) };
  return { values, writes, port };
}

test("fresh or malformed Chromium storage restores application backup and manual titles", async t => {
  const backup = preferences();
  const h = fixture(t, { backup });
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), backup);
  assert.deepEqual(sidebar.loadSidebarPreferences(), backup);
  h.values.set(key, "{broken");
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), backup);
});

test("valid legacy preferences migrate without reopening intentionally closed tabs", async t => {
  const local = preferences([]);
  const h = fixture(t, { local, projects: ["/historical"] });
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), local);
  assert.deepEqual(h.writes.at(-1), local);
});

test("the application backup wins over incomplete renderer storage", async t => {
  const backup = preferences();
  const h = fixture(t, { backup, local: preferences(["/default"]) });
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), backup);
});

test("an explicitly empty backup never queries the project catalog", async t => {
  const h = fixture(t, { backup: preferences([]) });
  h.port.listProjects = async () => { throw new Error("Closed tabs must not query the catalog"); };
  assert.deepEqual((await sidebar.restoreSidebarPreferences(h.port)).openProjectPaths, []);
});

test("cache loss recovers known projects once and persists subsequent closes", async t => {
  const h = fixture(t, { projects: ["/default", "/work/alpha", "/work/beta"] });
  const recovered = await sidebar.restoreSidebarPreferences(h.port);
  assert.deepEqual(recovered.openProjectPaths, ["/default", "/work/alpha", "/work/beta"]);
  sidebar.saveSidebarPreferences({ ...recovered, openProjectPaths: ["/default"] });
  await Promise.resolve();
  h.port.read = async () => h.writes.at(-1);
  assert.deepEqual((await sidebar.restoreSidebarPreferences(h.port)).openProjectPaths, ["/default"]);
});

test("a failed backup read cannot overwrite it with empty startup state", async t => {
  const h = fixture(t);
  h.port.read = async () => { throw new Error("Synthetic disk unavailable"); };
  assert.equal(await sidebar.restoreSidebarPreferences(h.port), null);
  sidebar.saveSidebarPreferences(preferences(["/default"]));
  await Promise.resolve();
  assert.deepEqual(h.writes, []);
});

test("a project catalog failure cannot persist an empty recovery result", async t => {
  const h = fixture(t);
  h.port.listProjects = async () => { throw new Error("Synthetic Host unavailable"); };
  await assert.rejects(sidebar.restoreSidebarPreferences(h.port), /Host unavailable/);
  assert.deepEqual(h.writes, []);
});

for (const phase of ["read", "listProjects", "write"]) {
  test(`user changes during recovery ${phase} supersede the old snapshot`, async t => {
    const h = fixture(t);
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    h.port[phase] = (...args) => {
      if (phase === "write") h.writes.push(args[0]);
      started.resolve();
      return pending.promise;
    };
    const recovering = sidebar.restoreSidebarPreferences(h.port);
    await started.promise;
    const newer = preferences(["/newly-opened"]);
    sidebar.saveSidebarPreferences(newer);
    pending.resolve(phase === "read" ? preferences(["/old"]) : phase === "listProjects" ? { projects: [] } : undefined);
    assert.deepEqual(await recovering, newer);
    assert.deepEqual(h.writes.at(-1), newer);
  });
}

test("a superseded restore cannot publish or persist over a newer bootstrap", async t => {
  const h = fixture(t);
  const old = Promise.withResolvers();
  const first = sidebar.restoreSidebarPreferences({ ...h.port, read: () => old.promise });
  const newer = preferences(["/new"]);
  assert.deepEqual(await sidebar.restoreSidebarPreferences({ ...h.port, read: async () => newer }), newer);
  old.resolve(preferences(["/old"]));
  assert.equal(await first, null);
  assert.deepEqual(sidebar.loadSidebarPreferences(), newer);
  assert.deepEqual(h.writes, [newer]);
});

test("a failed backup write retains recovered metadata and later saves retry", async t => {
  const backup = preferences();
  const h = fixture(t, { backup });
  const write = h.port.write;
  let unavailable = true;
  h.port.write = async value => {
    if (unavailable) throw new Error("Synthetic disk full");
    return write(value);
  };
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), backup);
  assert.deepEqual(sidebar.loadSidebarPreferences(), backup);
  unavailable = false;
  sidebar.saveSidebarPreferences(preferences(["/after-recovery"]));
  await Promise.resolve();
  assert.deepEqual(h.writes.at(-1).openProjectPaths, ["/after-recovery"]);
});
