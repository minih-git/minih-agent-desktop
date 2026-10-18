/**
 * The title input may read pasted text, so it must read only what the session
 * itself pasted: no other session's scratch, no arbitrary absolute path, no
 * symlink that points outside, no binary, and never more than its budget.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { MAX_PASTED_TITLE_CHARS, readPastedPromptMaterial } = await import(
  "../electron/main/session-title-input.ts"
);

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-title-input-"));
  const pastedDir = join(dataDir, "scratch", "s1", "pasted");
  const otherDir = join(dataDir, "scratch", "s2", "pasted");
  await mkdir(pastedDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  return { dataDir, pastedDir, otherDir };
}

test("reads the pasted text a session's own chip points at", async () => {
  const { dataDir, pastedDir } = await fixture();
  try {
    const file = join(pastedDir, "pasted-a1b2-notes.txt");
    await writeFile(file, "  第三季度导出报表  \n", "utf8");
    assert.equal(
      await readPastedPromptMaterial({ dataDir, sessionId: "s1", prompt: `@${file}` }),
      "第三季度导出报表",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ignores another session's paste, a missing file, and a non-text paste", async () => {
  const { dataDir, pastedDir, otherDir } = await fixture();
  try {
    const foreign = join(otherDir, "pasted-c3d4-secret.txt");
    await writeFile(foreign, "另一个会话的内容", "utf8");
    const image = join(pastedDir, "pasted-e5f6-shot.png");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const prompt = `@${foreign} @${image} @${join(pastedDir, "missing.txt")}`;
    assert.equal(await readPastedPromptMaterial({ dataDir, sessionId: "s1", prompt }), "");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("refuses a symlink that escapes the pasted directory", async () => {
  const { dataDir, pastedDir } = await fixture();
  try {
    const outside = join(dataDir, "outside.txt");
    await writeFile(outside, "不在粘贴目录中的内容", "utf8");
    const link = join(pastedDir, "pasted-g7h8-link.txt");
    await symlink(outside, link);
    assert.equal(
      await readPastedPromptMaterial({ dataDir, sessionId: "s1", prompt: `@${link}` }),
      "",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("stops at the character budget and the file count", async () => {
  const { dataDir, pastedDir } = await fixture();
  try {
    const paths = [];
    for (let index = 0; index < 5; index += 1) {
      const file = join(pastedDir, `pasted-i${index}-part.txt`);
      await writeFile(file, `${index}:`.padEnd(4_000, "x"), "utf8");
      paths.push(file);
    }
    const material = await readPastedPromptMaterial({
      dataDir,
      sessionId: "s1",
      prompt: paths.map((path) => `@${path}`).join(" "),
    });
    assert.ok(Array.from(material).length <= MAX_PASTED_TITLE_CHARS, String(material.length));
    assert.equal(material.split("\n\n").length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an invalid session id reads nothing", async () => {
  const { dataDir, pastedDir } = await fixture();
  try {
    const file = join(pastedDir, "pasted-j9k0-note.txt");
    await writeFile(file, "内容", "utf8");
    assert.equal(
      await readPastedPromptMaterial({ dataDir, sessionId: "../s2", prompt: `@${file}` }),
      "",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("refuses a pasted directory that is itself a link out of the session", async () => {
  // Checking only the link-free file inside `pasted/` misses this: when
  // `pasted/` is the link, its target silently becomes the trusted root.
  const dataDir = await mkdtemp(join(tmpdir(), "pi-title-root-"));
  try {
    const elsewhere = join(dataDir, "outside-session");
    await mkdir(elsewhere, { recursive: true });
    const secret = join(elsewhere, "fixture.txt");
    await writeFile(secret, "SYNTHETIC_OUTSIDE_SESSION_MARKER", "utf8");
    await mkdir(join(dataDir, "scratch", "s1"), { recursive: true });
    await symlink(elsewhere, join(dataDir, "scratch", "s1", "pasted"), "dir");

    assert.equal(
      await readPastedPromptMaterial({
        dataDir,
        sessionId: "s1",
        prompt: `@${join(dataDir, "scratch", "s1", "pasted", "fixture.txt")}`,
      }),
      "",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a large paste contributes its bounded prefix instead of nothing", async () => {
  const { dataDir, pastedDir } = await fixture();
  try {
    // Composer accepts multi-megabyte pastes; a whole-file size gate dropped
    // them entirely, so the session kept its placeholder name.
    const file = join(pastedDir, "pasted-l1m2-big.txt");
    await writeFile(file, `Export inventory report\n${"x".repeat(600 * 1024)}`, "utf8");
    const material = await readPastedPromptMaterial({
      dataDir,
      sessionId: "s1",
      prompt: `@${file}`,
    });
    assert.match(material, /^Export inventory report/);
    assert.ok(Array.from(material).length <= MAX_PASTED_TITLE_CHARS, String(material.length));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a prefix cut through a multi-byte character keeps valid text", async () => {
  const { dataDir, pastedDir } = await fixture();
  try {
    const file = join(pastedDir, "pasted-n3o4-utf8.txt");
    // Three-byte characters straddle the 64 KiB prefix boundary.
    await writeFile(file, "界".repeat(80 * 1024), "utf8");
    const material = await readPastedPromptMaterial({
      dataDir,
      sessionId: "s1",
      prompt: `@${file}`,
    });
    assert.doesNotMatch(material, /\uFFFD/);
    assert.match(material, /^界+$/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
