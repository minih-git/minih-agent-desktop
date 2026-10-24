import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import type { UiMessage } from "@minih-agent/shared";
import { toRacpItem } from "./host-ports.js";
import type { HostRpc, HostSessionRecord } from "./host-ports.js";
import { createSessionMediaAccess, createSessionMediaVerification, encodeSessionMediaId } from "./session-media.js";

const temps: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A verification cache that records every hash it was asked to trust.
 *
 * The reader hashes a blob only when the cache has not already verified this
 * file version, so the recorded keys are exactly the full passes over the file.
 */
function recordingVerification() {
  const inner = createSessionMediaVerification();
  const marked: string[] = [];
  return {
    marked,
    isVerified: (key: string) => inner.isVerified(key),
    mark: (key: string) => {
      marked.push(key);
      inner.mark(key);
    },
  };
}

type Fixture = {
  dataDir: string;
  sha256: string;
  bytes: Buffer;
  mediaId: string;
  sessionId: string;
  /** Every `session.get` the reader made, so transcript reads stay observable. */
  hostCalls: () => number;
  getHost: () => HostRpc;
};

/**
 * A Host data dir with one session whose transcript shows one image, plus the
 * blob under `attachments/<sha256>`: the only shape the reader serves.
 */
async function fixture(content?: Buffer): Promise<Fixture> {
  const dataDir = await tempDir("pi-session-media-");
  const bytes = content ?? Buffer.alloc(8 * 64 * 1024, 7);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(dataDir, "attachments"), { recursive: true });
  await writeFile(join(dataDir, "attachments", sha256), bytes);

  const sessionId = "s-media";
  const messageId = "m-1";
  const messages = [
    {
      id: messageId,
      role: "assistant",
      content: "",
      attachments: [{ id: "att-1", kind: "image", mimeType: "image/png", ref: `attachments/${sha256}`, name: "a.png" }],
    },
  ] as unknown as UiMessage[];
  let calls = 0;
  const session: HostSessionRecord = { id: sessionId, messages };
  const getHost = (): HostRpc => ({
    async call<T>(method: string): Promise<T> {
      if (method !== "session.get") throw new Error(`unexpected ${method}`);
      calls += 1;
      return { session } as T;
    },
  });
  return {
    dataDir,
    sha256,
    bytes,
    mediaId: encodeSessionMediaId(messageId, "att-1"),
    sessionId,
    hostCalls: () => calls,
    getHost,
  };
}

it("hashes a blob once per download, not once per chunk", async () => {
  const media = await fixture();
  // A 512 KB image in sixteen 32 KB reads: the shape of one preview download.
  const chunk = 32 * 1024;
  const chunkCount = Math.ceil(media.bytes.length / chunk);
  const verification = recordingVerification();
  const reader = createSessionMediaAccess({
    getHost: media.getHost,
    dataDir: media.dataDir,
    verification,
  });

  let offset = 0;
  while (offset < media.bytes.length) {
    const next = await reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset, length: chunk });
    const served = Buffer.from(next.data, "base64").length;
    expect(served).toBeGreaterThan(0);
    if (offset === 0) {
      expect(next.totalBytes).toBe(media.bytes.length);
      expect(next.sha256).toBe(media.sha256);
    }
    offset += served;
  }
  expect(offset).toBe(media.bytes.length);
  // Membership was re-read for every chunk: it is never assumed from an earlier one.
  expect(media.hostCalls()).toBe(chunkCount);

  // One full pass over the file for the whole download. Hashing per chunk would
  // have verified (and so re-read) the same 512 KB sixteen times.
  expect(verification.marked).toHaveLength(1);
  expect(verification.marked[0]).toContain(media.sha256);
});

it("still refuses a blob whose bytes no longer hash to its name", async () => {
  const media = await fixture();
  // Same name, different bytes: the file the transcript recorded is not this one.
  await writeFile(join(media.dataDir, "attachments", media.sha256), Buffer.alloc(media.bytes.length, 9));
  const reader = createSessionMediaAccess({ getHost: media.getHost, dataDir: media.dataDir });

  await expect(
    reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset: 0, length: 1024 }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  // A later chunk of the same replaced file is refused too, not served unverified.
  await expect(
    reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset: 1024, length: 1024 }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

it("refuses a chunk offset outside the file, a bad length, and a symlinked blob", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const media = await fixture();
  const reader = createSessionMediaAccess({ getHost: media.getHost, dataDir: media.dataDir });

  await expect(
    reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset: media.bytes.length, length: 1 }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(
    reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset: 0, length: 0 }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

  // A symlink planted where the blob should be resolves outside the root.
  const elsewhere = await tempDir("pi-session-media-outside-");
  await writeFile(join(elsewhere, "copy.png"), media.bytes);
  await rm(join(media.dataDir, "attachments", media.sha256));
  await symlink(join(elsewhere, "copy.png"), join(media.dataDir, "attachments", media.sha256));
  await expect(
    reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset: 0, length: 16 }),
  ).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
});

it("refuses media that the session's transcript no longer holds", async () => {
  const media = await fixture();
  const empty: HostRpc = {
    async call<T>(): Promise<T> {
      return { session: { id: media.sessionId, messages: [] } } as T;
    },
  };
  const reader = createSessionMediaAccess({ getHost: () => empty, dataDir: media.dataDir });
  await expect(
    reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset: 0, length: 16 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("serves a user's own photo, whose stored attachment carries no id at all", async () => {
  // The stored shape of a message a person sent with a picture, copied from a
  // real session record: kind/name/ref/mimeType/size and no id, because
  // host-core's `MessageAttachment` has no such field. Encoding and reading must
  // still agree on one row identity, or the photo is unreachable from the phone.
  const dataDir = await tempDir("pi-session-media-photo-");
  const bytes = Buffer.from("a user's jpeg, stored byte for byte");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(dataDir, "attachments"), { recursive: true });
  await writeFile(join(dataDir, "attachments", sha256), bytes);

  const stored = {
    id: "m-photo",
    role: "user",
    content: "what is this",
    createdAt: "2026-10-24T00:00:00.000Z",
    status: "complete",
    attachments: [
      {
        type: "attachment",
        kind: "image",
        mimeType: "image/jpeg",
        name: "IMG_3516.jpeg",
        ref: `attachments/${sha256}`,
        size: bytes.length,
      },
    ],
  } as unknown as UiMessage;

  // What the phone is told: one media id derived from the row's position.
  const item = toRacpItem(stored);
  const mediaId = (item.content as { attachments?: Array<{ mediaId?: string }> }).attachments?.[0]?.mediaId;
  expect(mediaId).toBe(encodeSessionMediaId("m-photo", "idx-0"));

  // What the phone then asks for, resolved against the same id-less record.
  const host: HostRpc = {
    async call<T>(method: string): Promise<T> {
      if (method !== "session.get") throw new Error(`unexpected ${method}`);
      return { session: { id: "s-photo", messages: [stored] } } as T;
    },
  };
  const reader = createSessionMediaAccess({ getHost: () => host, dataDir });
  const read = await reader.read({ sessionId: "s-photo", mediaId: mediaId ?? "", offset: 0, length: 4096 });
  expect(Buffer.from(read.data, "base64").toString()).toBe(bytes.toString());
  expect(read.sha256).toBe(sha256);
});

it("still resolves a media id minted from an old, id-bearing attachment", async () => {
  // Ids already handed to a phone encode `att-<id>`; those attachments keep
  // their own id as the row identity, so the older link must not break.
  const media = await fixture();
  const reader = createSessionMediaAccess({ getHost: media.getHost, dataDir: media.dataDir });
  const read = await reader.read({ sessionId: media.sessionId, mediaId: media.mediaId, offset: 0, length: 16 });
  expect(read.totalBytes).toBe(media.bytes.length);
});