/**
 * The terminal engine: every PTY this plugin owns, and nothing else.
 *
 * One instance lives in the plugin's own host process (an Electron
 * `utilityProcess`, a sibling of the app rather than part of it). It is plain
 * Node so the tests in `test/` can drive real shells without Electron.
 *
 * Two bounds keep a chatty program from eating the app:
 *
 * - Each terminal buffers at most `HIGH_WATER_BYTES` of undelivered output, and
 *   the PTY is paused above it. A paused PTY stops draining the kernel buffer,
 *   so the child blocks on a real pipe instead of losing output; the view pulls
 *   in `READ_CHUNK_BYTES` pieces only after xterm has consumed the previous one.
 * - The registry holds at most `MAX_TERMINALS` terminals.
 *
 * Output reaches the view as a string. node-pty decodes UTF-8 with a decoder
 * that survives a multi-byte character split across two reads, and Node's
 * string semantics keep that true across the bridge, so no half characters are
 * produced at chunk borders.
 */
const { execFileSync } = require("node:child_process");
const { homedir } = require("node:os");
const { resolve } = require("node:path");
const { detectShellProfiles, findProfile, isLocalDirectory } = require("./shells.js");

const READ_CHUNK_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 256 * 1024;
const LOW_WATER_BYTES = 64 * 1024;
const MAX_TERMINALS = 12;
/** How long one `read` waits for output before answering empty-handed. */
const READ_WAIT_MS = 3_000;
/** How long a close waits for the process to actually be gone. */
const CLOSE_TIMEOUT_MS = 2_000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Load the pinned `node-pty` build.
 *
 * The packaged plugin ships platform assets under `vendor/node-pty`; a
 * development checkout resolves the same package from `node_modules`. A build
 * without an asset for this platform says so, naming what it does carry, rather
 * than failing later inside a native loader.
 */
function loadNodePty(loader = require) {
  const attempts = [];
  for (const specifier of ["../vendor/node-pty", "node-pty"]) {
    try {
      return loader(specifier);
    } catch (error) {
      attempts.push(`${specifier}: ${error?.message ?? error}`);
    }
  }
  throw codedError(
    "PTY_UNAVAILABLE",
    `no PTY backend for ${process.platform}-${process.arch}. This plugin build must ship ` +
      `vendor/node-pty/prebuilds/${process.platform}-${process.arch}. Tried ${attempts.join("; ")}`,
  );
}

class TerminalEngine {
  /** @type {Map<string, any>} */
  #terminals = new Map();
  #sequence = 0;
  #ptyModule = null;
  #profiles = null;
  #disposed = false;

  constructor({
    loadPty = loadNodePty,
    detectProfiles = detectShellProfiles,
    isDirectory = (path) => isLocalDirectory(path),
    home = homedir(),
    platform = process.platform,
    env = process.env,
  } = {}) {
    this.loadPty = loadPty;
    this.detectProfiles = detectProfiles;
    this.isDirectory = isDirectory;
    this.home = home;
    this.platform = platform;
    this.env = env;
  }

  /** Installed interactive shells, in the order this platform prefers them. */
  profiles() {
    if (!this.#profiles) {
      this.#profiles = this.detectProfiles({ platform: this.platform, env: this.env });
    }
    return this.#profiles;
  }

  /** Everything the view needs to draw its start form and its tab strip. */
  catalog() {
    return {
      profiles: this.profiles().map(({ id, label, file }) => ({ id, label, file })),
      terminals: this.list(),
      home: this.home,
      platform: this.platform,
    };
  }

  list() {
    return [...this.#terminals.values()].map((terminal) => ({
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.cwd,
      shell: terminal.shell.file,
      profileId: terminal.profile.id,
      exited: terminal.exited,
      exitCode: terminal.exitCode,
    }));
  }

  /**
   * Start one interactive shell.
   *
   * `cwd` must be an existing local directory. A path that only exists on
   * another machine (a remote project) is refused by name instead of being
   * silently replaced with the home directory.
   */
  open({ cwd, profileId, cols, rows } = {}, { maxTerminals = MAX_TERMINALS } = {}) {
    if (this.#disposed) throw codedError("DISPOSED", "the terminal engine is shut down");
    if (this.#terminals.size >= maxTerminals) {
      throw codedError(
        "TOO_MANY_TERMINALS",
        `this plugin holds at most ${maxTerminals} terminals; close one first`,
      );
    }
    const profiles = this.profiles();
    if (profiles.length === 0) {
      throw codedError(
        "NO_PROFILE",
        "no supported interactive shell was found on this machine (PowerShell or cmd on " +
          "Windows; zsh, bash, or sh on macOS and Linux)",
      );
    }
    const profile = findProfile(profiles, profileId);
    if (!profile) {
      const known = profiles.map((candidate) => candidate.id).join(", ");
      throw codedError(
        "PROFILE_MISSING",
        `shell "${profileId}" is not installed here (available: ${known})`,
      );
    }
    const directory = typeof cwd === "string" && cwd.trim() ? resolve(cwd) : this.home;
    if (!this.isDirectory(directory)) {
      throw codedError(
        "CWD_MISSING",
        `the working directory ${directory} does not exist on this machine`,
      );
    }

    const ptyModule = this.loadPty();
    const id = `t${++this.#sequence}`;
    const pty = ptyModule.spawn(profile.file, profile.args, {
      name: "xterm-256color",
      cols: clamp(cols, 2, 1_000, 80),
      rows: clamp(rows, 1, 500, 24),
      cwd: directory,
      env: this.#shellEnv(directory),
    });

    /** @type {any} */
    const record = {
      id,
      pty,
      profile,
      cwd: directory,
      title: `${baseName(directory)} · ${profile.label}`,
      shell: { file: profile.file },
      /** Undelivered output, oldest first. */
      queue: [],
      queuedBytes: 0,
      paused: false,
      waiter: null,
      exited: false,
      exitCode: null,
      signal: null,
      closed: false,
    };
    this.#terminals.set(id, record);

    pty.onData((data) => this.#onData(record, data));
    pty.onExit(({ exitCode, signal }) => {
      record.exited = true;
      record.exitCode = typeof exitCode === "number" ? exitCode : null;
      record.signal = typeof signal === "number" ? signal : null;
      this.#settle(record);
    });

    return {
      id,
      title: record.title,
      cwd: record.cwd,
      shell: profile.file,
      profileId: profile.id,
      cols: cols ?? 80,
      rows: rows ?? 24,
    };
  }

  /**
   * Take up to `limit` bytes of pending output, waiting `waitMs` for some.
   *
   * The wait makes the view's poll a long poll: an idle terminal costs one
   * request every `waitMs`, while keystroke echo still arrives immediately
   * because the promise settles as soon as output appears.
   */
  async read({ id, limit, waitMs = READ_WAIT_MS } = {}) {
    const terminal = this.#require(id);
    const chunk = this.#drain(terminal, limit);
    if (chunk.data || terminal.exited) {
      return { data: chunk.data, exited: terminal.exited, exitCode: terminal.exitCode };
    }
    await this.#waitForOutput(terminal, clamp(waitMs, 0, READ_WAIT_MS, READ_WAIT_MS));
    const settled = this.#drain(terminal, limit);
    return {
      data: settled.data,
      exited: terminal.exited,
      exitCode: terminal.exitCode,
    };
  }

  /** Send keyboard input to the shell. */
  write({ id, data } = {}) {
    const terminal = this.#require(id);
    if (typeof data !== "string" || data.length === 0) return { ok: true };
    if (data.length > READ_CHUNK_BYTES) {
      throw codedError("INVALID_ARGUMENT", "input is too large for one write");
    }
    if (terminal.exited || terminal.closed) return { ok: false, reason: "exited" };
    terminal.pty.write(data);
    return { ok: true };
  }

  /** Match the PTY's window size to what the view actually renders. */
  resize({ id, cols, rows } = {}) {
    const terminal = this.#require(id);
    if (terminal.exited || terminal.closed) return { ok: false, reason: "exited" };
    const nextCols = clamp(cols, 2, 1_000, null);
    const nextRows = clamp(rows, 1, 500, null);
    if (nextCols === null || nextRows === null) {
      throw codedError("INVALID_ARGUMENT", "resize needs integer cols and rows");
    }
    terminal.pty.resize(nextCols, nextRows);
    return { ok: true, cols: nextCols, rows: nextRows };
  }

  /**
   * End one terminal and report what happened.
   *
   * The answer is only `ok` once the process is gone. A shell that outlives the
   * close timeout is reported as a failure with its pid, because claiming
   * cleanup that did not happen hides a stray process from the user.
   */
  async close({ id } = {}) {
    const terminal = this.#terminals.get(String(id ?? ""));
    if (!terminal) return { ok: true, already: true };
    terminal.closed = true;
    this.#settle(terminal);
    /**
     * End the shell's whole process tree, not just the shell.
     *
     * A shell with job control puts every background job in its own process
     * group, so signalling the shell's group misses them, and whether they die
     * with the shell is the shell's own policy (bash/zsh resend SIGHUP, a
     * dash-like `sh` does not). An explicit close therefore walks the tree,
     * signals the descendants first, then the shell, and escalates to SIGKILL if
     * the graceful half of the budget was not enough.
     */
    const shellPid = terminal.pty?.pid;
    const descendants =
      this.platform === "win32" || typeof shellPid !== "number"
        ? []
        : this.#descendants(shellPid);
    const signalTree = (signal) => {
      if (this.platform === "win32") return;
      for (const child of descendants) {
        try {
          process.kill(child, signal);
        } catch {
          // Already gone.
        }
      }
      if (typeof shellPid !== "number" || shellPid <= 0) return;
      try {
        process.kill(-shellPid, signal);
      } catch {
        // Not a group leader any more, or already gone.
      }
      try {
        process.kill(shellPid, signal);
      } catch {
        // Already gone.
      }
    };
    if (!terminal.exited) {
      try {
        terminal.pty.kill();
        signalTree("SIGHUP");
      } catch (error) {
        // A process that already went away is the outcome we wanted.
        if (!terminal.exited) {
          this.#terminals.delete(terminal.id);
          throw codedError(
            "CLOSE_FAILED",
            `could not stop terminal ${terminal.id}: ${error?.message ?? error}`,
          );
        }
      }
    }
    if (!(await this.#waitForExit(terminal, Math.floor(CLOSE_TIMEOUT_MS / 2)))) {
      // A shell that traps or ignores the hangup still has to go: the user
      // closed the tab, and half the budget is enough for a graceful exit.
      signalTree("SIGKILL");
      try {
        terminal.pty.kill("SIGKILL");
      } catch {
        // Already gone between the two signals.
      }
    }
    const gone = await this.#waitForExit(terminal, CLOSE_TIMEOUT_MS);
    this.#terminals.delete(terminal.id);
    if (!gone) {
      throw codedError(
        "CLOSE_TIMEOUT",
        `terminal ${terminal.id} is still running after ${CLOSE_TIMEOUT_MS} ms`,
      );
    }
    return { ok: true, exitCode: terminal.exitCode };
  }

  /** Stop every terminal, as plugin unload, disable, and app quit require. */
  async closeAll() {
    const errors = [];
    let closed = 0;
    for (const id of [...this.#terminals.keys()]) {
      try {
        await this.close({ id });
        closed += 1;
      } catch (error) {
        errors.push({ id, message: error?.message ?? String(error) });
      }
    }
    return { closed, failures: errors };
  }

  /** Best-effort synchronous kill for a process that is already exiting. */
  killAllSync() {
    for (const terminal of this.#terminals.values()) {
      terminal.closed = true;
      try {
        terminal.pty.kill();
      } catch {
        // Nothing left to do while the process is going away.
      }
    }
    this.#terminals.clear();
  }

  /** Refuse further work; the plugin process is being torn down. */
  dispose() {
    this.#disposed = true;
    this.killAllSync();
  }

  // --- internals -------------------------------------------------------

  /** Pids of every descendant of `pid`, deepest last; empty when unavailable. */
  #descendants(pid) {
    let listing;
    try {
      listing = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
        encoding: "utf8",
        timeout: 2_000,
      });
    } catch {
      // No `ps` on this system: the group and shell signals still run.
      return [];
    }
    const children = new Map();
    for (const line of listing.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
      const bucket = children.get(parent);
      if (bucket) bucket.push(child);
      else children.set(parent, [child]);
    }
    const ordered = [];
    const walk = (current) => {
      for (const child of children.get(current) ?? []) {
        walk(child);
        ordered.push(child);
      }
    };
    walk(pid);
    return ordered;
  }

  #shellEnv(cwd) {
    const env = { ...this.env, TERM: "xterm-256color", COLORTERM: "truecolor", PWD: cwd };
    // The shell is the user's, not Electron's: handing it the launcher's
    // internal switches would make `process.execPath` behave like the app.
    for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "NODE_OPTIONS"]) {
      delete env[key];
    }
    if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
    return env;
  }

  #require(id) {
    const terminal = this.#terminals.get(String(id ?? ""));
    if (!terminal) throw codedError("NOT_FOUND", `no such terminal: ${String(id ?? "")}`);
    return terminal;
  }

  #onData(terminal, data) {
    if (terminal.closed || typeof data !== "string" || data.length === 0) return;
    const bytes = Buffer.byteLength(data, "utf8");
    terminal.queue.push({ text: data, bytes });
    terminal.queuedBytes += bytes;
    if (terminal.queuedBytes >= HIGH_WATER_BYTES && !terminal.paused) {
      terminal.paused = true;
      try {
        // Real backpressure: the child stops when the kernel buffer fills.
        terminal.pty.pause();
      } catch {
        // A PTY that cannot pause still delivers; the cap below bounds memory.
      }
    }
    this.#settle(terminal);
  }

  #drain(terminal, limit) {
    const max = clamp(limit, 1, READ_CHUNK_BYTES, READ_CHUNK_BYTES);
    let data = "";
    let taken = 0;
    while (terminal.queue.length > 0) {
      const head = terminal.queue[0];
      if (taken + head.bytes <= max) {
        terminal.queue.shift();
        data += head.text;
        taken += head.bytes;
        continue;
      }
      // Split inside this chunk, on code points only, so a surrogate pair is
      // never cut in half between two reads.
      let piece = "";
      let pieceBytes = 0;
      for (const codePoint of head.text) {
        const size = Buffer.byteLength(codePoint, "utf8");
        if (taken + pieceBytes + size > max) break;
        piece += codePoint;
        pieceBytes += size;
      }
      if (pieceBytes === 0) break;
      head.text = head.text.slice(piece.length);
      head.bytes -= pieceBytes;
      data += piece;
      taken += pieceBytes;
      break;
    }
    terminal.queuedBytes -= taken;
    if (terminal.paused && terminal.queuedBytes <= LOW_WATER_BYTES) {
      terminal.paused = false;
      try {
        terminal.pty.resume();
      } catch {
        // Resuming a dead PTY is not an error worth surfacing.
      }
    }
    return { data };
  }

  #settle(terminal) {
    const waiter = terminal.waiter;
    if (!waiter) return;
    terminal.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  #waitForOutput(terminal, waitMs) {
    if (terminal.exited || terminal.closed || waitMs <= 0) return Promise.resolve();
    if (terminal.queue.length > 0) return Promise.resolve();
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        if (terminal.waiter?.timer === timer) terminal.waiter = null;
        resolvePromise();
      }, waitMs);
      terminal.waiter = { resolve: resolvePromise, timer };
    });
  }

  #waitForExit(terminal, timeoutMs) {
    if (terminal.exited) return Promise.resolve(true);
    return new Promise((resolvePromise) => {
      const started = Date.now();
      const poll = () => {
        if (terminal.exited) {
          resolvePromise(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolvePromise(false);
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  }
}

function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function baseName(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

module.exports = {
  TerminalEngine,
  codedError,
  loadNodePty,
  READ_CHUNK_BYTES,
  HIGH_WATER_BYTES,
  LOW_WATER_BYTES,
  MAX_TERMINALS,
  READ_WAIT_MS,
};
