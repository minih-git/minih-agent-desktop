import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Seed a new production-schema fixture with mesh networking disabled. */
export function seedOfflineHostData(root, dataDir) {
  const file = join(dataDir, "pi.sqlite");
  assert(!existsSync(file), "offline seed requires a new isolated database");
  mkdirSync(dataDir, { recursive: true });
  const read = (path) => readFileSync(join(root, "crates/host-core/src", path), "utf8");
  const raw = (text) => [...text.matchAll(/r#"([\s\S]*?)"#/g)].map((match) => match[1]);
  const schema = read("db/schema.rs");
  const todo = raw(schema.split("pub(crate) const SCHEMA_LATEST")[0])[0];
  const latest = raw(schema.split("pub(crate) const SCHEMA_LATEST")[1].split("pub(crate) const PLAN_APPROVALS_SCHEMA")[0]);
  assert.equal(latest.length, 2, "fresh schema shape changed");
  const constant = (path, name) => raw(read(path).split(`const ${name}`)[1])[0];
  const version = Number(read("db.rs").match(/SCHEMA_VERSION: i64 = (\d+)/)[1]);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec(latest[0] + todo + latest[1]);
    db.exec(constant("db/schema.rs", "PLAN_APPROVALS_SCHEMA"));
    db.exec(read("session_collaboration/schema.sql"));
    db.exec(constant("db/worktree_migration.rs", "WORKTREE_DDL"));
    db.exec(constant("db/prompt_notification_migration.rs", "NOTIFICATIONS_DDL"));
    db.exec(constant("db/learned_memory_migration.rs", "LEARNED_MEMORY_DDL"));
    db.exec(`PRAGMA user_version = ${version}`);
    db.prepare("INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?,?,?,?)")
      .run("app", "app", JSON.stringify({ easytier: { enabled: false } }), Date.now());
  } finally { db.close(); }
}
