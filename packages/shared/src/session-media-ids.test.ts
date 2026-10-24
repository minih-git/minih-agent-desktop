import { describe, expect, it } from "vitest";

import {
  encodeSessionMediaId,
  generatedImageAttachments,
  isSessionMediaAttachment,
  sessionAttachmentRowId,
  withSessionMediaIds,
} from "./session-media-ids.js";
import type { MessageAttachment } from "./types/messages.js";

const SHA = "a".repeat(64);

function photo(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return { kind: "image", name: "photo.png", ref: `attachments/${SHA}`, mimeType: "image/png", ...overrides };
}

describe("session media ids", () => {
  it("encodes the same id the Node built-in would", () => {
    // The Host writes ids on the server and the clients only carry them, so the
    // two encoders have to agree byte for byte.
    const messageId = "0581cb5e-2730-4932-af3f-62a4b5a2a2c0";
    expect(encodeSessionMediaId(messageId, "idx-0")).toBe(
      `media_${Buffer.from(`${messageId}/idx-0`, "utf8").toString("base64url")}`,
    );
    // A row id with a slash in it would make the id ambiguous; the separator is
    // the first one, so the row keeps the rest.
    expect(encodeSessionMediaId("m1", "att-2")).toBe(`media_${Buffer.from("m1/att-2").toString("base64url")}`);
  });

  it("addresses an attachment by its own id, or by its position", () => {
    expect(sessionAttachmentRowId({ id: "att-7" }, 3)).toBe("att-7");
    expect(sessionAttachmentRowId({}, 0)).toBe("idx-0");
    expect(sessionAttachmentRowId({ id: "  " }, 2)).toBe("idx-2");
  });

  it("names media only where the Host can read it back", () => {
    expect(isSessionMediaAttachment(photo())).toBe(true);
    expect(isSessionMediaAttachment(photo({ mimeType: "image/jpeg" }))).toBe(true);
    // A label is not the rule: SVG can carry script and is never served.
    expect(isSessionMediaAttachment(photo({ mimeType: "image/svg+xml" }))).toBe(false);
    // Only content-addressed blobs are readable, not paths or links.
    expect(isSessionMediaAttachment(photo({ ref: "/Users/me/Pictures/cat.png" }))).toBe(false);
    expect(isSessionMediaAttachment(photo({ ref: "attachments/ABC" }))).toBe(false);
    expect(isSessionMediaAttachment({ kind: "file", name: "a.pdf", ref: `attachments/${SHA}` })).toBe(false);
  });

  it("annotates a readable image and leaves everything else untouched", () => {
    const message = { id: "m1", attachments: [photo(), photo({ kind: "file", name: "notes.pdf", ref: `attachments/${SHA}` })] };
    const projected = withSessionMediaIds(message);

    expect(projected).not.toBe(message);
    expect(projected.attachments?.[0]).toMatchObject({ mediaId: encodeSessionMediaId("m1", "idx-0") });
    // The PDF keeps its plain ref: it has no media for the phone to read.
    expect(projected.attachments?.[1]).not.toHaveProperty("mediaId");
  });

  it("returns the same message when there is nothing to name", () => {
    // A transcript read walks thousands of messages; the projection must not copy
    // the ones that carry no readable media.
    const plain = { id: "m2", attachments: [photo({ ref: "https://example.test/cat.png" })] };
    expect(withSessionMediaIds(plain)).toBe(plain);
    const bare = { id: "m3" };
    expect(withSessionMediaIds(bare)).toBe(bare);
  });
});

describe("an image a tool generated", () => {
  /** The result as the tool reports it: JSON text inside a content block. */
  function toolResult(entries: unknown[]) {
    return { content: [{ type: "text", text: JSON.stringify({ kind: "generated-images", results: entries }) }] };
  }

  it("becomes media the phone can name, by position in the result", () => {
    const message: { id: string; role: string; toolResult: unknown; attachments?: MessageAttachment[] } = {
      id: "m-call",
      role: "tool",
      toolResult: toolResult([
        {
          index: 0,
          status: "succeeded",
          path: "/tmp/generated.png",
          ref: `attachments/${SHA}`,
          mimeType: "image/png",
          name: "generated.png",
          size: 1234,
        },
      ]),
    };

    expect(generatedImageAttachments(message)).toEqual([
      { kind: "image", name: "generated.png", ref: `attachments/${SHA}`, mimeType: "image/png", size: 1234, id: "img-0" },
    ]);
    // The path stays for the desktop; the ref is what a phone reads back.
    const projected = withSessionMediaIds(message);
    expect(projected.attachments?.[0]).toMatchObject({ mediaId: encodeSessionMediaId("m-call", "img-0") });
  });

  it("is not media when the tool only reported a path", () => {
    // An older build reports `path` and nothing else, which a phone cannot open.
    const message = {
      id: "m-call",
      role: "tool",
      toolResult: toolResult([{ index: 0, status: "succeeded", path: "/tmp/generated.png", mimeType: "image/png" }]),
    };

    expect(generatedImageAttachments(message)).toEqual([]);
    expect(withSessionMediaIds(message)).toBe(message);
  });

  it("skips a failed operation and keeps the row id of the one that worked", () => {
    const message = {
      id: "m-call",
      role: "tool",
      toolResult: toolResult([
        { index: 0, status: "failed", mimeType: "image/png" },
        { index: 1, status: "succeeded", ref: `attachments/${SHA}`, mimeType: "image/png" },
      ]),
    };

    expect(generatedImageAttachments(message).map((row) => row.id)).toEqual(["img-1"]);
  });
});