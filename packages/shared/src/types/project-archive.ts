/**
 * Contracts for the explicit project archive: one logical project or project
 * group as a versioned ZIP file.
 *
 * Cloud sync transports global configuration only, so moving a project to
 * another machine is one explicit export and one explicit import. The archive
 * carries the project's files and its app-managed project configuration; it
 * never carries chat history, credentials, MCP secret values, plugin binaries
 * or runtime state, and an import never establishes a sync relationship.
 */

export type ProjectArchiveExportRequest = {
  /** Registered project path; the Host resolves the project or its group. */
  projectPath: string;
};

export type ProjectArchiveExportResult = {
  targetPath: string;
  name: string;
  roots: number;
  files: number;
  bytes: number;
  /** Symbolic links are not archived; this is how many a copy could not carry. */
  skippedSymlinks: number;
  /**
   * App-managed MCP definition files left out because they keep secret values.
   * The archive carries a sanitized definition instead.
   */
  skippedSecretFiles: number;
};

export type ProjectArchiveExportOutcome =
  | { canceled: true }
  | ({ canceled: false } & ProjectArchiveExportResult);

export type ProjectArchiveImportResult = {
  projectPaths: string[];
  groupId: string | null;
  roots: number;
  files: number;
  name: string;
};

export type ProjectArchiveImportOutcome =
  | { canceled: true }
  | ({ canceled: false } & ProjectArchiveImportResult);

/** What one archive operation is doing while it runs. */
export type ProjectArchivePhase = "scan" | "export" | "import";

export type ProjectArchiveProgress = {
  phase: ProjectArchivePhase;
  /** Units done so far within this phase: bytes for export, entries for import. */
  done: number;
  total: number;
};
