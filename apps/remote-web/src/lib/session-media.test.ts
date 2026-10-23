import { describe, expect, it, vi } from "vitest";

import { RacpError } from "@minih-agent/racp/browser";

import { SESSION_MEDIA_CHUNK_BYTES, disposeSessionMedia, readSessionMedia, type SessionMediaClient } from "./session-media.js";

/** Bytes shaped like a small PNG payload; the helper never parses the image. */
function payload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251;
  return bytes;
}

/**
 * A Host that answers `session/mediaRead` from one in-memory blob, in the same
 * bounds the real one enforces: a request past the end of the chunk budget is a
 * failure, not a clamped answer.
 */
function mediaHost(blob: Uint8Array, options: { chunkBytes?: number } = {}): {
  client: SessionMediaClient;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const chunkBytes = options.chunkBytes ?? SESSION_MEDIA_CHUNK_BYTES;
  const client: SessionMediaClient = {
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, ...params });
      if (method !== "session/mediaRead") throw new Error(`unexpected ${method}`);
      const offset = Number(params.offset ?? 0);
      const length = Number(params.length ?? chunkBytes);
      if (length > chunkBytes) throw new RacpError("INVALID_ARGUMENT", "media read length exceeds the per-read chunk limit");
      if (offset >= blob.length) throw new RacpError("INVALID_ARGUMENT", "media read offset is outside the file");
      const slice = blob.subarray(offset, Math.min(offset + length, blob.length));
      return {
        mime: "image/png",
        totalBytes: blob.length,
        offset,
        data: Buffer.from(slice).toString("base64"),
        sha256: "a".repeat(64),
      } as T;
    },
  };
  return { client, calls };
}

describe("readSessionMedia (D6, rollout B4)", () => {
  it("reads a small image in one bounded call and builds a viewer item", async () => {
    const blob = payload(1024);
    const { client, calls } = mediaHost(blob);
    const state = await readSessionMedia(client, { sessionId: "s1", mediaId: "media_x", name: "shot.png" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "session/mediaRead", sessionId: "s1", mediaId: "media_x", offset: 0, length: SESSION_MEDIA_CHUNK_BYTES });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.item).toMatchObject({ id: "media_x", mime: "image/png", name: "shot.png" });
    expect(state.item.url.startsWith("blob:")).toBe(true);
  });

  it("walks an image larger than one chunk sequentially, without skipping or repeating bytes", async () => {
    // 2.5 chunks: the last answer is short, exactly as the Host sends it.
    const blob = payload(SESSION_MEDIA_CHUNK_BYTES * 2 + 1024);
    const { client, calls } = mediaHost(blob);
    const state = await readSessionMedia(client, { sessionId: "s1", mediaId: "media_big" });
    expect(state.kind).toBe("ready");
    expect(calls.map((call) => call.offset)).toEqual([0, SESSION_MEDIA_CHUNK_BYTES, SESSION_MEDIA_CHUNK_BYTES * 2]);
  });

  it("names an old Host instead of showing a broken preview", async () => {
    const client: SessionMediaClient = {
      request: () => Promise.reject(new RacpError("CAPABILITY_UNAVAILABLE", "this Host does not offer session media reads")),
    };
    expect(await readSessionMedia(client, { sessionId: "s1", mediaId: "media_x" })).toEqual({ kind: "unsupported" });
  });

  it("distinguishes deleted, changed, and forbidden media states", async () => {
    const gone: SessionMediaClient = {
      request: () =>
        Promise.reject(
          new RacpError("REMOTE_PATH_NOT_FOUND", "this image is no longer on the computer", { details: { reason: "media-unavailable" } }),
        ),
    };
    expect(await readSessionMedia(gone, { sessionId: "s1", mediaId: "media_x" })).toEqual({ kind: "deleted" });
    const changed: SessionMediaClient = {
      request: () =>
        Promise.reject(new RacpError("CONFLICT", "this image changed on the computer", { details: { reason: "media-changed" } })),
    };
    expect(await readSessionMedia(changed, { sessionId: "s1", mediaId: "media_x" })).toEqual({ kind: "changed" });
    const forbidden: SessionMediaClient = {
      request: () => Promise.reject(new RacpError("FORBIDDEN", "access denied")),
    };
    expect(await readSessionMedia(forbidden, { sessionId: "s1", mediaId: "media_x" })).toEqual({ kind: "forbidden" });
  });

  it("keeps an unknown refusal as a named failure so the screen can explain it", async () => {
    const client: SessionMediaClient = {
      request: () => Promise.reject(new RacpError("INTERNAL", "unexpected host error")),
    };
    const state = await readSessionMedia(client, { sessionId: "s1", mediaId: "media_x" });
    expect(state).toMatchObject({ kind: "failed", failure: { code: "INTERNAL" } });
  });

  it("refuses an out-of-order chunk instead of assembling a corrupt image", async () => {
    let call = 0;
    const client: SessionMediaClient = {
      request: async <T,>(): Promise<T> => {
        call += 1;
        return { mime: "image/png", totalBytes: SESSION_MEDIA_CHUNK_BYTES * 2, offset: call === 1 ? 0 : 10, data: "AAAA" } as T;
      },
    };
    const state = await readSessionMedia(client, { sessionId: "s1", mediaId: "media_x" });
    expect(state).toMatchObject({ kind: "failed", failure: { code: "INTERNAL" } });
  });

  it("refuses an image past the client ceiling before downloading all of it", async () => {
    const client: SessionMediaClient = {
      request: async <T,>(): Promise<T> => ({ mime: "image/png", totalBytes: 64 * 1024 * 1024, offset: 0, data: "AAAA" }) as T,
    };
    const state = await readSessionMedia(client, { sessionId: "s1", mediaId: "media_x" });
    expect(state).toMatchObject({ kind: "failed", failure: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("revokes only the object URLs it created", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    disposeSessionMedia({ id: "m", url: "blob:http://localhost/x" });
    disposeSessionMedia({ id: "m", url: "data:image/png;base64,AAAA" });
    disposeSessionMedia(null);
    expect(revoke).toHaveBeenCalledTimes(1);
    revoke.mockRestore();
  });
});