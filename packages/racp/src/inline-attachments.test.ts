import { describe, expect, it } from "vitest";
import type { RacpInitializeResult } from "@minih-agent/shared";

import { RACP_INLINE_ATTACHMENT_MAX_BYTES } from "@minih-agent/shared";
import { OWNER_TOKEN, harness } from "./test-harness.js";

const context = (requestId: string) => ({ requestId });

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const base64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const text = (value: string) => base64(new TextEncoder().encode(value));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03);

/** A store that records what it was asked to write, without touching a disk. */
function recordingStore() {
  const written: Array<{ sessionId: string; name: string; mimeType: string; kind: string; size: number }> = [];
  return {
    written,
    port: {
      async store(input: { sessionId: string; name: string; mimeType: string; kind: "image" | "file"; bytes: Uint8Array }) {
        written.push({
          sessionId: input.sessionId,
          name: input.name,
          mimeType: input.mimeType,
          kind: input.kind,
          size: input.bytes.byteLength,
        });
        return { path: `attachments/${written.length}` };
      },
    },
  };
}

/**
 * Inline attachments (§10 step 1): the Host takes the bytes on their own terms.
 *
 * These pin the two halves that must never drift: the capability decides whether
 * the operation exists at all, and the content — not the label the phone sends —
 * decides what reaches the runtime.
 */
describe("inline attachments", () => {
  it("is not offered by a Host with nowhere to put the bytes", async () => {
    const h = await harness();
    const { client } = await h.connect(OWNER_TOKEN);
    expect((client.initialized as RacpInitializeResult).capabilities.attachments).toBe(false);
    await expect(
      client.request("turn/start", {
        sessionId: "s1",
        input: { text: "look", attachments: [{ name: "shot.png", mimeType: "image/png", data: base64(PNG) }] },
        context: context("r1"),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await client.close();
  });

  it("stores a picture and hands the runtime its on-disk form", async () => {
    const store = recordingStore();
    const h = await harness({ operations: { inlineAttachments: store.port } });
    const { client } = await h.connect(OWNER_TOKEN);
    expect((client.initialized as RacpInitializeResult).capabilities.attachments).toBe(true);
    await client.request("turn/start", {
      sessionId: "s1",
      input: { text: "what is this?", attachments: [{ name: "shot.png", mimeType: "image/png", data: base64(PNG) }] },
      context: context("r1"),
    });
    expect(store.written).toEqual([
      { sessionId: "s1", name: "shot.png", mimeType: "image/png", kind: "image", size: PNG.byteLength },
    ]);
    expect(h.runtime.prompts[0]?.attachments).toEqual([
      { path: "attachments/1", name: "shot.png", kind: "image", mimeType: "image/png", size: PNG.byteLength },
    ]);
    await client.close();
  });

  it("takes a UTF-8 text file as a file, not as a picture", async () => {
    const store = recordingStore();
    const h = await harness({ operations: { inlineAttachments: store.port } });
    const { client } = await h.connect(OWNER_TOKEN);
    await client.request("turn/start", {
      sessionId: "s1",
      input: { text: "read this", attachments: [{ name: "main.ts", mimeType: "text/plain", data: text("const a = 1\n") }] },
      context: context("r1"),
    });
    expect(h.runtime.prompts[0]?.attachments?.[0]).toMatchObject({ kind: "file", mimeType: "text/plain; charset=utf-8" });
    await client.close();
  });

  it("refuses a label that disagrees with the bytes", async () => {
    const store = recordingStore();
    const h = await harness({ operations: { inlineAttachments: store.port } });
    const { client } = await h.connect(OWNER_TOKEN);
    // `image/jpg` is what several phones actually send for a JPEG; the bytes here
    // are a PNG, so the label is the thing that is wrong.
    await expect(
      client.request("turn/start", {
        sessionId: "s1",
        input: { text: "look", attachments: [{ name: "shot.png", mimeType: "image/jpg", data: base64(PNG) }] },
        context: context("r1"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // The dangerous direction: text announced as the picture a model trusts.
    await expect(
      client.request("turn/start", {
        sessionId: "s1",
        input: { text: "look", attachments: [{ name: "shot.png", mimeType: "image/png", data: text("not a picture") }] },
        context: context("r2"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(store.written).toHaveLength(0);
    expect(h.runtime.prompts).toHaveLength(0);
    await client.close();
  });

  it("refuses bytes nothing can read, and a data URL", async () => {
    const store = recordingStore();
    const h = await harness({ operations: { inlineAttachments: store.port } });
    const { client } = await h.connect(OWNER_TOKEN);
    await expect(
      client.request("turn/start", {
        sessionId: "s1",
        input: { text: "look", attachments: [{ name: "blob", data: base64(bytes(0x61, 0x00, 0x62)) }] },
        context: context("r1"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.request("turn/start", {
        sessionId: "s1",
        input: { text: "look", attachments: [{ name: "shot.png", data: `data:image/png;base64,${base64(PNG)}` }] },
        context: context("r2"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(store.written).toHaveLength(0);
    await client.close();
  });

  it("refuses an attachment past the inline budget", async () => {
    const store = recordingStore();
    const h = await harness({ operations: { inlineAttachments: store.port } });
    const { client } = await h.connect(OWNER_TOKEN);
    // A real PNG header followed by padding, so only the size rule can refuse it.
    const oversized = new Uint8Array(RACP_INLINE_ATTACHMENT_MAX_BYTES + 1);
    oversized.set(PNG.subarray(0, 8), 0);
    await expect(
      client.request("turn/start", {
        sessionId: "s1",
        input: { text: "look", attachments: [{ name: "huge.png", mimeType: "image/png", data: base64(oversized) }] },
        context: context("r1"),
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(store.written).toHaveLength(0);
    await client.close();
  });

  it("bounds how many attachments one prompt may carry", async () => {
    const store = recordingStore();
    const h = await harness({ operations: { inlineAttachments: store.port } });
    const { client } = await h.connect(OWNER_TOKEN);
    const one = { name: "shot.png", mimeType: "image/png", data: base64(PNG) };
    await expect(
      client.request("turn/start", {
        sessionId: "s1",
        input: { text: "look", attachments: Array.from({ length: 7 }, () => one) },
        context: context("r1"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await client.close();
  });
});
