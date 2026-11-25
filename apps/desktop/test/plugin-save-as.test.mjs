/**
 * `pi.fs.saveAs`: the one write a plugin makes outside its sandbox.
 *
 * What is proved here: the user's chosen path is the only destination, a
 * cancelled dialog writes nothing, the suggested name cannot smuggle a path or a
 * control character, the size bound holds, the app's own data directory and a
 * few system locations are refused, and the permission gate is `fs.write`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { MAX_SAVE_AS_BYTES, refusedSavePath, safeSaveName, saveAsOne } = await import(
  "../electron/main/plugin-save-as.ts"
);

const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();

function sandbox(t) {
  const dir = mkdtempSync(join(scratch, "save-as-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a suggested name is reduced to one harmless path segment", () => {
  assert.equal(safeSaveName("invoice.pdf"), "invoice.pdf");
  // A plugin may suggest a path; only the last segment survives, because the
  // dialog is the only thing that may choose a directory.
  assert.equal(safeSaveName("../../etc/passwd"), "passwd");
  assert.equal(safeSaveName("C:\\Windows\\System32\\evil.dll"), "evil.dll");
  assert.equal(safeSaveName("a\u0000b\u001f.txt"), "ab.txt");
  assert.equal(safeSaveName(".hidden"), "hidden");
  assert.equal(safeSaveName("   "), "attachment");
  assert.equal(safeSaveName(""), "attachment");
  assert.equal(safeSaveName("x".repeat(400)).length, 180);
});

test("the app's own data directory and system locations are refused", () => {
  const data = "/Users/someone/Library/Application Support/Minih";
  assert.equal(refusedSavePath(`${data}/state.db`, data), "the app's own data directory");
  assert.equal(refusedSavePath(data, data), "the app's own data directory");
  assert.equal(refusedSavePath("/etc/hosts", data), "a system location");
  assert.equal(refusedSavePath("/Users/someone/Desktop/report.pdf", data), null);
  // A different directory that merely shares a prefix is not the data directory.
  assert.equal(refusedSavePath(`${data}-backup/report.pdf`, data), null);
});

test("a cancelled dialog writes nothing and answers null", async (t) => {
  const dir = sandbox(t);
  const target = join(dir, "never-written.pdf");
  const answer = await saveAsOne({ choosePath: async () => null }, {
    suggestedName: "never-written.pdf",
    data: new Uint8Array([1, 2, 3]),
  });
  assert.equal(answer, null);
  assert.throws(() => readFileSync(target));
});

test("the bytes land in the path the user picked, and only there", async (t) => {
  const dir = sandbox(t);
  const target = join(dir, "hello.txt");
  let asked = "";
  const answer = await saveAsOne(
    {
      choosePath: async (options) => {
        asked = options.defaultPath;
        return target;
      },
    },
    { suggestedName: "../../hello.txt", data: new Uint8Array([104, 105]) },
  );
  assert.deepEqual(answer, { path: target, name: "hello.txt" });
  // The dialog was offered the sanitised name, not the suggested path.
  assert.equal(asked, "hello.txt");
  assert.equal(readFileSync(target, "utf8"), "hi");
});

test("an empty file and an oversized one are refused before the dialog", async () => {
  let asked = 0;
  const deps = {
    choosePath: async () => {
      asked += 1;
      return null;
    },
  };
  await assert.rejects(saveAsOne(deps, { suggestedName: "a.bin", data: new Uint8Array(0) }), /non-empty/);
  const huge = new Uint8Array(MAX_SAVE_AS_BYTES + 1);
  await assert.rejects(saveAsOne(deps, { suggestedName: "a.bin", data: huge }), /at most/);
  assert.equal(asked, 0, "nothing was asked before the file was known to be writable");
});

test("a destination the host refuses is an error, not a silent success", async (t) => {
  const data = sandbox(t);
  const target = join(data, "state.json");
  writeFileSync(join(data, "keep.txt"), "keep");
  await assert.rejects(
    saveAsOne({ choosePath: async () => target, dataDir: data }, {
      suggestedName: "state.json",
      data: new Uint8Array([1]),
    }),
    /data directory/,
  );
  assert.throws(() => readFileSync(target));
  assert.equal(readFileSync(join(data, "keep.txt"), "utf8"), "keep");
});

test("Windows paths are judged by Windows rules", () => {
  const data = "C:\\Users\\minih\\AppData\\Roaming\\Minih";
  // The data directory and its children, case-insensitively.
  assert.equal(refusedSavePath(`${data}\\state.db`, data, "win32"), "the app's own data directory");
  assert.equal(
    refusedSavePath("c:\\users\\MINIH\\appdata\\roaming\\minih\\state.db", data, "win32"),
    "the app's own data directory",
  );
  // Windows system locations.
  assert.equal(refusedSavePath("C:\\Windows\\System32\\drivers\\etc\\hosts", data, "win32"), "a system location");
  assert.equal(refusedSavePath("C:\\Program Files\\Evil\\x.dll", data, "win32"), "a system location");
  assert.equal(refusedSavePath("C:\\Program Files (x86)\\Evil\\x.dll", data, "win32"), "a system location");
  // A user folder is fine, including one that merely shares a prefix.
  assert.equal(refusedSavePath("C:\\Users\\minih\\Desktop\\report.pdf", data, "win32"), null);
  assert.equal(refusedSavePath(`${data}-backup\\report.pdf`, data, "win32"), null);
});
