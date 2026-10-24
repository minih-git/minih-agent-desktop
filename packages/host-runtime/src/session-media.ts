/**
 * Session-media reads, shared by both Hosts (D6, rollout B4).
 *
 * A remote screenshot or a generated image has to reopen after the phone
 * forgets everything, so the transcript's own attachments are the only media
 * this serves. Three properties keep it from becoming a filesystem browser:
 *
 * - **Membership is the authorization.** The media id is the attachment row's
 *   `id` inside one message of *this* session's transcript. The Host re-reads
 *   that transcript on every call and refuses anything it does not find, so
 *   holding an id from another session, another device, or an old build buys
 *   nothing.
 * - **Only canonical raster blobs.** The row's `ref` must be
 *   `attachments/<64 lowercase hex>` and nothing else — no absolute path, no
 *   `..`, no URL, no `file://`, no sibling `state.db`. That reference is then
 *   resolved inside the Host data root with a `realpath` containment check, so
 *   a symlink planted in the attachments directory cannot escape either.
 * - **The bytes must still be the bytes.** The sha256 in the name is verified
 *   against the file before its first byte is served (a changed or replaced
 *   blob is a conflict, not a preview), the size is bounded, and the working
 *   tree is not consulted at all: an output the user deleted from the project
 *   is still the image the transcript recorded, and a project file is never
 *   readable here.
 *
 * Reads are bounded and sequential: one range per call, at most
 * `RACP_SESSION_MEDIA_MAX_CHUNK_BYTES`, with a validated offset and length.
 * Because a large image is many calls, the full-file hash is computed once per
 * blob version (see `verifyBlob`), not once per chunk: a later chunk of the
 * same unchanged file is bounded and path-checked but not re-hashed.
 */
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RacpError } from "@minih-agent/agent-host";
import type { RacpSessionMediaAccess, RacpSessionMediaReadResult } from "@minih-agent/racp";
import { SESSION_MEDIA_ID_PREFIX, sessionAttachmentRowId, withSessionMediaIds, type UiMessage } from "@minih-agent/shared";

import { toRacpHostError } from "./host-catalog-reads.js";
import type { HostRpc, HostSessionRecord } from "./host-ports.js";

/**
 * Upper bound on one media file. The desktop inlines images up to roughly this
 * size into a prompt, so anything larger is not a picture the transcript was
 * ever able to show.
 */
export const SESSION_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** `attachments/<sha256>`, lowercase. The only ref shape this reader accepts. */
const MEDIA_REF_PATTERN = /^attachments\/([0-9a-f]{64})$/;

/**
 * Raster types a model can read. SVG is markup that can carry script and is
 * deliberately absent, exactly as inline attachments treat it.
 */
const RASTER_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type SessionMediaOptions = {
  getHost: () => HostRpc | null;
  /** The Host data directory: `attachments/<sha256>` lives directly under it. */
  dataDir: string;
};

/** One attachment row that is readable media. */
type MediaRow = { id: string; name: string; mimeType: string; sha256: string };

/**
 * The row identity and the opaque id built from it.
 *
 * Both live in `@minih-agent/shared` because the history read and the live event
 * stream build the same item, and the phone bundles the encoder; two copies of
 * this format would drift into media ids one side cannot resolve.
 */
export { encodeSessionMediaId, sessionAttachmentRowId } from "@minih-agent/shared";

/** The `{ messageId, rowId }` an id names, or `null` when it is not one. */
export function decodeSessionMediaId(mediaId: string): { messageId: string; rowId: string } | null {
  if (!mediaId.startsWith(SESSION_MEDIA_ID_PREFIX)) return null;
  const encoded = mediaId.slice(SESSION_MEDIA_ID_PREFIX.length);
  // The id arrives from an untrusted client: bound it before decoding, and only
  // accept the base64url alphabet so a path-looking value can never be built.
  if (!encoded || encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const separator = decoded.indexOf("/");
  if (separator <= 0 || separator === decoded.length - 1) return null;
  const messageId = decoded.slice(0, separator);
  const rowId = decoded.slice(separator + 1);
  if (!messageId || !rowId) return null;
  return { messageId, rowId };
}

/**
 * The readable media of one attachment list.
 *
 * A row is media only when it is an image, its MIME is an allowlisted raster
 * type, and its ref is a content-addressed blob. Everything else — a workspace
 * PDF, a session link, an SVG, a legacy absolute path — is silently absent, so
 * the phone never sees a reference it could not read.
 */
function mediaRows(messages: readonly UiMessage[]): Array<MediaRow & { messageId: string }> {
  const rows: Array<MediaRow & { messageId: string }> = [];
  for (const message of messages) {
    // A generated image is reported by the tool result rather than stored as an
    // attachment, so the projection that clients use synthesizes its rows here
    // too: a phone must be able to read back what the agent drew.
    const attachments = withSessionMediaIds(message).attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) continue;
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.kind !== "image") continue;
      const mimeType = String(attachment.mimeType ?? "").trim().toLowerCase();
      if (!RASTER_MIME.has(mimeType)) continue;
      const match = MEDIA_REF_PATTERN.exec(String(attachment.ref ?? "").trim().replace(/\\/g, "/"));
      if (!match?.[1]) continue;
      const rowId = sessionAttachmentRowId(attachment, index);
      rows.push({
        messageId: message.id,
        id: rowId,
        name: attachment.name || mimeType,
        mimeType,
        sha256: match[1],
      });
    }
  }
  return rows;
}

/**
 * The transcript of one session, or a refusal.
 *
 * `messageLimit` is required by host-core whenever a window is named and must be
 * positive, and `messageAround` needs exclusive use of the window arguments —
 * so this asks for the largest window host-core accepts around the message the
 * client named. One transcript read is the whole point: the id is looked up in
 * it rather than answered from an index.
 */
async function readTranscript(
  getHost: () => HostRpc | null,
  sessionId: string,
  window: { messageId?: string } = {},
): Promise<HostSessionRecord> {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  const result = await host
    .call<{ session?: HostSessionRecord | null }>("session.get", {
      id: sessionId,
      ...(window.messageId
        ? { messageAround: window.messageId, messageLimit: SESSION_MEDIA_WINDOW_MESSAGES }
        : { messageLimit: SESSION_MEDIA_WINDOW_MESSAGES }),
    })
    .catch(toRacpHostError);
  if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
  return result.session;
}

/** Messages one media lookup reads. Enough to reach an attachment row without loading a 12 MB transcript. */
const SESSION_MEDIA_WINDOW_MESSAGES = 200;

/**
 * One opened, path-checked blob. `size` and the real path come from the open
 * handle, so the caller streams exactly the file whose stat was bounded.
 */
type BlobHandle = { path: string; size: number; handle: FileHandle };

/**
 * Resolve one media row to an opened canonical file, within the size bounds.
 *
 * Every call re-checks containment: the attachments root and the target are
 * both `realpath`ed, so a symlink planted in the attachments directory resolves
 * outside the root and is refused. The bytes are *not* hashed here — see
 * `verifyBlob`.
 */
async function openBlob(attachmentsDir: string, row: MediaRow): Promise<BlobHandle> {
  const attachmentsRoot = resolve(attachmentsDir);
  const candidate = join(attachmentsRoot, row.sha256);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(attachmentsRoot);
    realTarget = await realpath(candidate);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new RacpError("REMOTE_PATH_NOT_FOUND", "this image is no longer on the computer", {
        details: { reason: "media-unavailable" },
      });
    }
    throw new RacpError("INTERNAL", "the media blob could not be resolved");
  }
  // `realpath` already canonicalized the target, so a symlink placed in the
  // attachments directory resolves outside the root and is refused here.
  if (realTarget !== join(realRoot, row.sha256)) {
    throw new RacpError("REMOTE_PATH_FORBIDDEN", "media blob resolves outside the attachments directory");
  }

  const handle = await open(realTarget, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new RacpError("REMOTE_PATH_FORBIDDEN", "media blob is not a regular file");
    if (info.size <= 0 || info.size > SESSION_MEDIA_MAX_BYTES) {
      throw new RacpError("PAYLOAD_TOO_LARGE", "media blob is outside the readable size range", {
        details: { size: info.size, limit: SESSION_MEDIA_MAX_BYTES },
      });
    }
    return { path: realTarget, size: info.size, handle };
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

/**
 * The sha256 of the whole file behind an open handle.
 *
 * Reads from its own descriptor, so the answer is about the file that was
 * opened, not about a path that could have been replaced since.
 */
async function hashBlob(handle: FileHandle): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
  }
  return digest.digest("hex");
}

/**
 * Blobs whose bytes were hashed and matched their name, keyed by
 * `<real path>:<mtimeMs>:<size>`.
 *
 * A 20 MB image arrives as forty 512 KB reads; hashing all of it on every one
 * would cost forty full passes over the file. One pass per blob *version* is
 * enough: the key changes when the file is replaced or rewritten, so a changed
 * blob is hashed again and refused, and an unchanged one is not re-read. The
 * set is bounded so a long-lived Host cannot grow with the number of images it
 * has served; the oldest entry is dropped first.
 */
const VERIFIED_BLOB_LIMIT = 1024;

export type SessionMediaVerification = {
  /** Whether this session's media cache was already asked. */
  isVerified: (key: string) => boolean;
  mark: (key: string) => void;
};

/** An empty cache: every call hashes, which is what a short-lived reader needs. */
export function createSessionMediaVerification(limit = VERIFIED_BLOB_LIMIT): SessionMediaVerification {
  const verified = new Set<string>();
  return {
    isVerified: (key) => verified.has(key),
    mark(key) {
      // Re-insert so the most recently used key is the last to be dropped.
      verified.delete(key);
      verified.add(key);
      while (verified.size > limit) {
        const oldest = verified.values().next();
        if (oldest.done) break;
        verified.delete(oldest.value);
      }
    },
  };
}

/**
 * Refuse a blob whose bytes are not the bytes its name records.
 *
 * The full hash runs once per blob version: an earlier call that verified this
 * exact `<real path>:<mtimeMs>:<size>` is trusted, so the other chunks of one
 * large image are not forty more passes over the same file. A replaced or
 * rewritten file has a new key and is hashed again, so it is still refused.
 * Nothing else is skipped: the containment and bounds checks of `openBlob`
 * always run, and the transcript row is re-checked on every chunk.
 */
async function verifyBlob(row: MediaRow, blob: BlobHandle, verification: SessionMediaVerification): Promise<void> {
  const info = await blob.handle.stat();
  const key = `${blob.path}:${info.mtimeMs}:${info.size}`;
  if (verification.isVerified(key)) return;
  // The key names the file version: a replaced or rewritten blob is not in the
  // cache, so it is hashed again and refused if its bytes no longer match.
  if (await hashBlob(blob.handle) !== row.sha256) {
    throw new RacpError("CONFLICT", "this image changed on the computer", {
      details: { reason: "media-changed" },
    });
  }
  verification.mark(key);
}

export function createSessionMediaAccess(
  options: SessionMediaOptions & { verification?: SessionMediaVerification },
): RacpSessionMediaAccess {
  // `attachments/<sha256>` is where both Hosts already put an uploaded or pasted
  // image, so this reader needs no second storage location (and no schema).
  const attachmentsDir = join(options.dataDir, "attachments");
  const verification = options.verification ?? createSessionMediaVerification();
  return {
    async read(input): Promise<RacpSessionMediaReadResult> {
      const target = decodeSessionMediaId(input.mediaId);
      if (!target) throw new RacpError("INVALID_ARGUMENT", "media id is not a session media reference");

      // The window must contain the message the id names; a row the transcript
      // no longer holds is a refusal, not a lookup that "probably" works. This
      // runs on every chunk, so membership is never assumed from an earlier one.
      const session = await readTranscript(options.getHost, input.sessionId, { messageId: target.messageId });
      const row = mediaRows(session.messages ?? []).find(
        (candidate) => candidate.messageId === target.messageId && candidate.id === target.rowId,
      );
      if (!row) {
        throw new RacpError("NOT_FOUND", "this session has no such media", {
          details: { reason: "media-not-in-session" },
        });
      }

      const blob = await openBlob(attachmentsDir, row);
      try {
        const offset = input.offset;
        const length = input.length;
        if (!Number.isInteger(offset) || offset < 0 || offset >= blob.size) {
          throw new RacpError("INVALID_ARGUMENT", "media read offset is outside the file", {
            details: { offset, totalBytes: blob.size },
          });
        }
        if (!Number.isInteger(length) || length <= 0) {
          throw new RacpError("INVALID_ARGUMENT", "media read length must be positive", { details: { length } });
        }
        await verifyBlob(row, blob, verification);
        const available = blob.size - offset;
        // A short answer at the end of the file is normal; a request that runs
        // past it is answered with what exists, because that is a client reading
        // the final chunk and not a mistake worth failing.
        const bytesToRead = Math.min(length, available);
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = await blob.handle.read(buffer, 0, bytesToRead, offset);
        return {
          mime: row.mimeType,
          totalBytes: blob.size,
          offset,
          data: buffer.subarray(0, bytesRead).toString("base64"),
          sha256: row.sha256,
        };
      } finally {
        await blob.handle.close();
      }
    },
  };
}