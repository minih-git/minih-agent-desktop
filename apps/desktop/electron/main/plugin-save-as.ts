/**
 * `pi.fs.saveAs`: one file, one destination the user picked themselves.
 *
 * A plugin that receives bytes it cannot reconstruct later — an attachment, a
 * rendered report — has nowhere to put them: `fs.writeText` writes inside the
 * sandbox under the plugin's own rules, and there is no binary write at all.
 * This is the other half: the host opens the native "save as" dialog and writes
 * exactly the one path the user chose. The choice is the authorisation, so the
 * sandbox root does not apply; everything else still does:
 *
 * - one file per call, at most 50 MiB;
 * - the suggested name is reduced to a single path segment, because the dialog
 *   is the only thing that may decide the directory;
 * - a small refusal list keeps the write out of the app's own data directory and
 *   a few system locations, so a plugin cannot overwrite its host's state or a
 *   system file by suggesting a clever path;
 * - a cancelled dialog writes nothing and answers `null`.
 */
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

/** Largest file one `saveAs` may write (50 MiB). */
export const MAX_SAVE_AS_BYTES = 50 * 1024 * 1024;

/** Longest file name this host will suggest or write. */
const MAX_NAME_LENGTH = 180;

/**
 * Absolute paths a plugin may not write through `saveAs`, in addition to what
 * the dialog itself allows.
 *
 * The list is about the host's own integrity, not about the user's choice: the
 * user may save wherever they like, but not into the app's data directory (its
 * databases, logs and credential store live there) and not into the handful of
 * system locations where a file of a plugin's choosing has consequences beyond
 * this app.
 */
const REFUSED_PREFIXES = ["/System", "/bin", "/sbin", "/usr/bin", "/etc", "/private/etc", "/dev", "/proc", "/sys"];

/** The refusal for one destination, or `null` when the path is allowed. */
export function refusedSavePath(path: string, dataDir: string | undefined): string | null {
  const target = resolve(path);
  if (dataDir) {
    const root = resolve(dataDir);
    if (target === root || target.startsWith(`${root}/`)) {
      return "the app's own data directory";
    }
  }
  if (REFUSED_PREFIXES.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))) {
    return "a system location";
  }
  return null;
}

/**
 * One suggested file name reduced to a single path segment.
 *
 * A plugin may suggest anything; what the dialog and the file system get is a
 * name with no separators, no control characters, no leading dots (so nothing
 * is hidden) and no `.`/`..`. An empty result becomes `attachment`.
 */
export function safeSaveName(suggested: string): string {
  const segment = basename(suggested.replaceAll("\\", "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/:]/g, "")
    .trim()
    .replace(/^\.+/, "");
  const name = segment.slice(0, MAX_NAME_LENGTH).trim();
  return name || "attachment";
}

/** What the host needs in order to ask for a destination and then write it. */
export type SaveAsDeps = {
  /** The native dialog; answers the chosen file path, or `null` when cancelled. */
  choosePath: (options: { defaultPath: string }) => Promise<string | null>;
  /** Where the app keeps its own data, refused as a destination. */
  dataDir?: string;
};

export type SaveAsInput = {
  suggestedName: string;
  data: Uint8Array;
  mimeType?: string;
};

/**
 * Write one file to a destination the user picks.
 *
 * Answers the written path and its name, or `null` when the user cancelled. A
 * refused destination is an error, not a silent no-op: the plugin asked for a
 * write and did not get one.
 */
export async function saveAsOne(
  deps: SaveAsDeps,
  input: SaveAsInput,
): Promise<{ path: string; name: string } | null> {
  const bytes = input.data;
  if (!(bytes instanceof Uint8Array)) throw new Error("saveAs needs binary data");
  if (bytes.byteLength === 0) throw new Error("saveAs needs a non-empty file");
  if (bytes.byteLength > MAX_SAVE_AS_BYTES) {
    throw new Error(`saveAs accepts at most ${MAX_SAVE_AS_BYTES} bytes`);
  }
  const name = safeSaveName(input.suggestedName);
  const chosen = await deps.choosePath({ defaultPath: name });
  if (!chosen) return null;
  const refused = refusedSavePath(chosen, deps.dataDir);
  if (refused) throw new Error(`saveAs cannot write into ${refused}`);
  await writeFile(chosen, bytes);
  return { path: chosen, name: basename(chosen) };
}