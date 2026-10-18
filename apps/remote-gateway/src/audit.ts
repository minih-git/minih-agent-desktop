/**
 * Redacted audit log (security §10, rollout R4 exit criterion 6). One JSON
 * object per line under `audit/YYYY-MM-DD.jsonl`; the record type is closed on
 * purpose so a token, credential, or message content cannot be appended by
 * accident.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type AuditResult = "ok" | "denied" | "error";

export type AuditRecord = {
  /** ISO-8601 timestamp. */
  ts: string;
  /** RACP operation or gateway-local operation name, e.g. `turn/start`, `pair`, `devices.revoke`. */
  op: string;
  hostId?: string;
  deviceId?: string;
  /** Router account id (protocol §11.5); never the AccessKey itself. */
  accountId?: string;
  result: AuditResult;
  /** Client IP; never a port, never a forwarded identity header. */
  ip: string;
};

export type AuditInput = Omit<AuditRecord, "ts">;

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export class AuditLog {
  constructor(
    private readonly directory: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `YYYY-MM-DD` in UTC, the file the record belongs to. */
  private static dayOf(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private filePath(day: string): string {
    return join(this.directory, `${day}.jsonl`);
  }

  async append(record: AuditInput): Promise<void> {
    const timestamp = this.now();
    const line = `${JSON.stringify({ ts: new Date(timestamp).toISOString(), ...record })}\n`;
    await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    await appendFile(this.filePath(AuditLog.dayOf(timestamp)), line, { encoding: "utf8", mode: FILE_MODE });
  }

  /** Records of one UTC day; tests and operators read it back through this. */
  async read(day: string): Promise<AuditRecord[]> {
    let text: string;
    try {
      text = await readFile(this.filePath(day), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditRecord);
  }
}
