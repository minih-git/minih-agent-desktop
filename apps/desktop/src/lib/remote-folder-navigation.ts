import { isAbsoluteRemotePath } from "@minih-agent/shared";

/**
 * The three decisions the remote folder picker makes about the path field.
 *
 * They live here rather than inline in the component so they can be tested
 * without an Electron window, and so the one rule they share — "an absolute
 * path in the *Host's* spelling" — comes from `@minih-agent/shared` instead of
 * a leading `/`. That assumption made a Windows Host's `C:\Users\…` read as a
 * relative path, which disabled "go to folder" and "use this folder" for every
 * directory the Host listed.
 */

/** The path to browse first: the typed one when it is absolute, else the Host's root. */
export function initialRemoteBrowsePath(initialPath: string): string | undefined {
  return isAbsoluteRemotePath(initialPath) ? initialPath : undefined;
}

/** Whether "go to folder" may ask the Host for the typed path. */
export function canGoToRemoteFolder(path: string, browsing: boolean): boolean {
  return !browsing && isAbsoluteRemotePath(path);
}

/**
 * Whether "use this folder" may submit.
 *
 * Only the directory the Host just listed: a typed path that has not been
 * browsed is what `canGoToRemoteFolder` is for, and submitting one would
 * register a directory nothing has confirmed exists.
 */
export function canChooseRemoteFolder(input: {
  directoryPath: string | undefined;
  path: string;
  browsing: boolean;
  failed: boolean;
}): boolean {
  return Boolean(input.directoryPath) && !input.browsing && !input.failed
    && input.path === input.directoryPath;
}

/** Whether the field holds something the Host cannot read as a path. */
export function needsAbsoluteRemotePath(path: string): boolean {
  return Boolean(path) && !isAbsoluteRemotePath(path);
}