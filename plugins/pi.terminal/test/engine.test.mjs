import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  HIGH_WATER_BYTES,
  READ_CHUNK_BYTES,
  TerminalEngine,
} = require("../dist/lib/terminal-engine.js");
const { detectShellProfiles } = require("../dist/lib/shells.js");

const profiles = detectShellProfiles();
const hasShell = profiles.length > 0;

function engine() {
  return new TerminalEngine({ home: process.cwd() });
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "pi-terminal-"));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

/** The job pid a terminal reported as `JOB=<pid> END`, or null. */
async function jobPidOf(current, id, timeoutMs = 20_000) {
  let seen = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await current.read({ id, waitMs: 200 });
    seen += reply.data;
    const match = /JOB=(\d+) END\r?\n/.exec(seen);
    if (match) return Number(match[1]);
    if (reply.exited) return null;
  }
  return null;
}

/** Read until `predicate` matches, the shell exits, or the budget runs out. */
async function readUntil(current, id, predicate, timeoutMs = 15_000) {
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await current.read({ id, waitMs: 200 });
    text += reply.data;
    if (predicate(text)) return { text, exited: reply.exited, exitCode: reply.exitCode };
    if (reply.exited) return { text, exited: true, exitCode: reply.exitCode };
  }
  throw new Error(`timed out; last output: ${JSON.stringify(text.slice(-500))}`);
}

test("lists the shells this machine actually has", { skip: !hasShell && "no local shell" }, () => {
  const catalog = engine().catalog();
  assert.ok(catalog.profiles.length > 0);
  for (const profile of catalog.profiles) {
    assert.equal(typeof profile.file, "string");
    assert.ok(profile.file.length > 0);
  }
  assert.equal(catalog.terminals.length, 0);
  assert.equal(catalog.home, process.cwd());
});

test("runs a real shell in the requested directory and answers its input and output", { skip: !hasShell && "no local shell" }, async () => {
  const directory = scratch();
  const current = engine();
  try {
    const opened = current.open({ cwd: directory, cols: 100, rows: 30 });
    assert.equal(opened.cwd, directory);
    assert.equal(opened.profileId, profiles[0].id);
    assert.ok(opened.title.includes(profiles[0].label));

    // The first prompt is the proof the shell started where it was told to: the
    // interactive prompt prints the working directory it opened in.
    const prompt = await readUntil(current, opened.id, (text) => text.includes("pi-terminal-"));
    assert.ok(prompt.text.includes(directory.split("/").pop()), prompt.text);

    current.write({ id: opened.id, data: "printf 'MARKER-%s\\n' terminal\n" });
    const echoed = await readUntil(current, opened.id, (text) => text.includes("MARKER-terminal"));
    assert.match(echoed.text, /MARKER-terminal/);
  } finally {
    await current.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a resize reaches the shell, so a full-screen program redraws at the new size", { skip: !hasShell && "no local shell" }, async () => {
  const current = engine();
  try {
    const opened = current.open({ cwd: process.cwd(), cols: 100, rows: 30 });
    const resized = current.resize({ id: opened.id, cols: 40, rows: 12 });
    assert.deepEqual(resized, { ok: true, cols: 40, rows: 12 });
    current.write({ id: opened.id, data: "stty size\n" });
    const reply = await readUntil(current, opened.id, (text) => /\b12 40\b/.test(text));
    assert.match(reply.text, /\b12 40\b/);
  } finally {
    await current.closeAll();
  }
});

test("an exiting shell reports its code and keeps its output readable", { skip: !hasShell && "no local shell" }, async () => {
  const current = engine();
  const opened = current.open({ cwd: process.cwd() });
  current.write({ id: opened.id, data: "exit 7\n" });
  const reply = await readUntil(current, opened.id, (text, exited) => exited, 15_000);
  assert.equal(reply.exited, true);
  assert.equal(reply.exitCode, 7);
  const listed = current.list();
  assert.equal(listed[0].exited, true);
  assert.equal(listed[0].exitCode, 7);
  await current.closeAll();
});

test("closing a terminal ends it and forgets it", { skip: !hasShell && "no local shell" }, async () => {
  const current = engine();
  const opened = current.open({ cwd: process.cwd() });
  const closed = await current.close({ id: opened.id });
  assert.equal(closed.ok, true);
  assert.deepEqual(current.list(), []);
  await assert.rejects(() => current.read({ id: opened.id }), /no such terminal/);
  assert.deepEqual(await current.close({ id: opened.id }), { ok: true, already: true });
});

test("closeAll ends every terminal and reports nothing as failed", { skip: !hasShell && "no local shell" }, async () => {
  const current = engine();
  current.open({ cwd: process.cwd() });
  current.open({ cwd: process.cwd() });
  const result = await current.closeAll();
  assert.deepEqual(result, { closed: 2, failures: [] });
  assert.deepEqual(current.list(), []);
});

test("a build without this platform's PTY says so instead of failing inside a loader", () => {
  const { loadNodePty } = require("../dist/lib/terminal-engine.js");
  const host = `${process.platform}-${process.arch}`;
  assert.throws(
    () =>
      loadNodePty(() => {
        throw new Error("Cannot find module '../vendor/node-pty'");
      }),
    (error) =>
      error.code === "PTY_UNAVAILABLE" &&
      error.message.includes(host) &&
      error.message.includes(`prebuilds/${host}`),
  );
});

test("refuses a directory or shell that is not here instead of substituting one", { skip: !hasShell && "no local shell" }, () => {
  const current = engine();
  assert.throws(
    () => current.open({ cwd: "/definitely/not/here", profileId: profiles[0].id }),
    (error) => error.code === "CWD_MISSING" && error.message.includes("/definitely/not/here"),
  );
  assert.throws(
    () => current.open({ cwd: process.cwd(), profileId: "no-such-shell" }),
    (error) =>
      error.code === "PROFILE_MISSING" && error.message.includes(profiles[0].id),
  );
  assert.throws(
    () => current.open({ cwd: process.cwd() }, { maxTerminals: 0 }),
    (error) => error.code === "TOO_MANY_TERMINALS",
  );
});

test(
  "closing a terminal ends the shell's background job in every installed shell",
  { skip: process.platform === "win32" && "no POSIX process groups" },
  async () => {
    const shells = detectShellProfiles();
    assert.ok(shells.length > 0, "no local shell to test");
    for (const profile of shells) {
      const current = engine();
      const opened = current.open({ cwd: process.cwd(), profileId: profile.id });
      current.write({ id: opened.id, data: "sleep 300 & printf 'JOB=%s END\\n' $!\n" });
      const jobPid = await jobPidOf(current, opened.id);
      assert.ok(jobPid, `${profile.file} never reported its job`);
      assert.ok(alive(jobPid), `${profile.file} job ${jobPid} must be running`);
      await current.close({ id: opened.id });
      const gone = await waitFor(() => !alive(jobPid), 8_000);
      if (!gone) {
        try {
          process.kill(jobPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      // The user closed the tab: the shell and the jobs it started both go,
      // whatever the shell's own exit behaviour is.
      assert.equal(gone, true, `${profile.file}: job ${jobPid} survived close()`);
      assert.deepEqual(current.list(), []);
    }
  },
);

/**
 * Flow control without a process: a fake PTY records pause/resume so the
 * high-water contract is observable byte for byte.
 */
function fakePtyModule() {
  const calls = { pause: 0, resume: 0, kills: 0, resizes: [] };
  let listeners = null;
  const module = {
    calls,
    emit(data) {
      listeners?.data(data);
    },
    finish(exitCode = 0) {
      listeners?.exit({ exitCode, signal: 0 });
    },
    spawn() {
      return {
        onData(handler) {
          listeners = { ...listeners, data: handler };
        },
        onExit(handler) {
          listeners = { ...listeners, exit: handler };
        },
        write() {},
        resize(cols, rows) {
          calls.resizes.push([cols, rows]);
        },
        pause() {
          calls.pause += 1;
        },
        resume() {
          calls.resume += 1;
        },
        kill() {
          calls.kills += 1;
        },
      };
    },
  };
  return module;
}

test("output above the high-water mark pauses the PTY and resumes once drained", () => {
  const pty = fakePtyModule();
  const current = new TerminalEngine({
    loadPty: () => pty,
    detectProfiles: () => [{ id: "sh", label: "sh", file: "/bin/sh", args: [] }],
    isDirectory: () => true,
    home: "/tmp",
  });
  const opened = current.open({ cwd: "/tmp" });
  const chunk = "A".repeat(4096);
  let pushed = 0;
  for (let index = 0; index < 100; index += 1) {
    pty.emit(chunk);
    pushed += chunk.length;
  }
  assert.ok(pushed > HIGH_WATER_BYTES);
  assert.equal(pty.calls.pause, 1, "pausing twice would be a second, contradicting signal");
  return (async () => {
    let read = 0;
    while (read < pushed) {
      const reply = await current.read({ id: opened.id, waitMs: 10 });
      assert.ok(Buffer.byteLength(reply.data, "utf8") <= READ_CHUNK_BYTES, "one read stays bounded");
      read += reply.data.length;
      if (pty.calls.resume > 0) break;
    }
    assert.ok(read <= pushed);
    assert.ok(
      pushed - read <= HIGH_WATER_BYTES,
      `the buffer must stay under its cap, not hold ${pushed - read} bytes`,
    );
    assert.equal(pty.calls.resume, 1);
    // Drain the rest so the assertion above is about the low-water mark only.
    while (read < pushed) {
      const reply = await current.read({ id: opened.id, waitMs: 10 });
      read += reply.data.length;
    }
    assert.equal(read, pushed);
    assert.ok(read - pushed === 0);
  })();
});

test("draining the queue never splits a surrogate pair or loses a byte", async () => {
  const pty = fakePtyModule();
  const current = new TerminalEngine({
    loadPty: () => pty,
    detectProfiles: () => [{ id: "sh", label: "sh", file: "/bin/sh", args: [] }],
    isDirectory: () => true,
    home: "/tmp",
  });
  const opened = current.open({ cwd: "/tmp" });
  // An emoji is two UTF-16 units and four UTF-8 bytes; a naive byte split would
  // emit half of it when the chunk boundary lands inside.
  const text = "漢字🙂".repeat(2000);
  pty.emit(text);
  let collected = "";
  while (collected.length < text.length) {
    const reply = await current.read({ id: opened.id, limit: 999, waitMs: 10 });
    collected += reply.data;
  }
  assert.equal(collected, text);
  assert.equal(Buffer.byteLength(collected, "utf8"), Buffer.byteLength(text, "utf8"));
  for (const bad of ["\ud83d", "\ude42"]) {
    assert.equal(collected.includes(bad) && !text.includes(bad), false);
  }
});
