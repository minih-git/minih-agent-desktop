//! Selected content adaptation of upstream b55628bf4 and e89807ba0.
//! Tests use only synthetic projects and temporary databases.
use super::*;

fn raw_project(db: &Database, path: &str, name: &str) -> i64 {
    db.conn()
        .execute(
            "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,?2,1,1)",
            params![path, name],
        )
        .unwrap();
    db.conn().last_insert_rowid()
}

fn session(db: &Database, id: &str, owner: i64) {
    db.conn()
        .execute(
            "INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES(?1,?2,1,1)",
            params![id, owner],
        )
        .unwrap();
}

fn row_count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn unicode_case_aliases_use_the_same_native_project_identity() {
    for (name, alias) in [("Älpha", "älpha"), ("Σ", "ς")] {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let folder = root.join(name);
        let alias = root.join(alias);
        let db = Database::open(&root.join("pi.sqlite")).unwrap();
        let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
        std::fs::create_dir(&folder).unwrap();
        if !alias.exists() {
            continue;
        }
        assert_eq!(
            db.ensure_project(folder.to_str().unwrap(), false).unwrap(),
            first
        );
        assert_eq!(db.list_projects().unwrap().len(), 1);
    }
}

#[test]
fn project_path_upgrade_preserves_every_owner_and_versioned_backup() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha").to_string_lossy().replace('\\', "/");
    std::fs::create_dir(&folder).unwrap();
    if !Path::new(&alias).exists() {
        return;
    }
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    let file = root.join("pi.sqlite");
    let second;
    {
        let db = Database::open(&file).unwrap();
        let first = db.ensure_project(&canonical, false).unwrap();
        db.conn()
            .execute(
                "UPDATE projects SET created_at=5,last_opened_at=2 WHERE id=?1",
                params![first],
            )
            .unwrap();
        second = raw_project(&db, &alias, "Kept name");
        db.conn().execute("UPDATE projects SET pinned=1,created_at=0,last_opened_at=9,worktree_setup_command='echo fixture' WHERE id=?1", params![second]).unwrap();
        for (id, project) in [("canonical", first), ("alias", second)] {
            session(&db, id, project);
            db.conn().execute("INSERT INTO scheduled_tasks(id,title,prompt,project_id,created_at,updated_at) VALUES(?1,'Task','Prompt',?2,1,1)", params![id, project]).unwrap();
        }
        db.kv_set("app", "currentProjectId", &serde_json::json!(second))
            .unwrap();
        db.kv_set(
            "projectMemory",
            &canonical,
            &serde_json::json!({"content":"Canonical memory"}),
        )
        .unwrap();
        db.kv_set(
            "projectMemory",
            &alias,
            &serde_json::json!({"content":"Alias memory"}),
        )
        .unwrap();
        db.conn().execute("INSERT INTO keep_warm_usage(id,session_id,status,created_at) VALUES('warm','alias','skipped',1)", []).unwrap();
        db.conn().execute("INSERT INTO conversation_summaries(session_id,summary_json,updated_at) VALUES('alias','{}',1)", []).unwrap();
        db.conn().pragma_update(None, "user_version", 29).unwrap();
    }
    let db = Database::open(&file).unwrap();
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    // A v29 file walks the ordered chain to the newest version in one launch,
    // so the assertion names the authority rather than the step that ran.
    assert_eq!(version, crate::db::SCHEMA_VERSION);
    assert_eq!(db.list_projects().unwrap().len(), 1);
    let keep = db.ensure_project(&alias, false).unwrap();
    assert_eq!(
        keep, second,
        "the newest row with sessions keeps its identity and name"
    );
    assert_eq!(db.ensure_project(&canonical, false).unwrap(), keep);
    assert_eq!(db.project_session_ids(&alias).unwrap().len(), 2);
    let tasks: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM scheduled_tasks WHERE project_id=?1",
            params![keep],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tasks, 2);
    let kept = db.get_project(keep).unwrap().unwrap();
    assert!(kept.pinned);
    assert_eq!(kept.name, "Kept name");
    assert_eq!(kept.created_at, 0);
    assert_eq!(
        db.kv_get("app", "currentProjectId").unwrap(),
        Some(serde_json::json!(keep))
    );
    assert_eq!(row_count(db.conn(), "keep_warm_usage"), 1);
    assert_eq!(row_count(db.conn(), "conversation_summaries"), 1);
    assert_eq!(
        db.kv_get("projectMemory", &canonical).unwrap().unwrap()["content"],
        "Canonical memory"
    );
    assert_eq!(
        db.kv_get("projectMemory", &alias).unwrap().unwrap()["content"],
        "Alias memory"
    );
    let backup = migration_backup_path(&file, 29);
    let before = Connection::open(&backup).unwrap();
    assert_eq!(row_count(&before, "projects"), 2);
    let before_version: i64 = before
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before_version, 29);
    drop(before);
    drop(db);
    let original_backup = std::fs::read(&backup).unwrap();
    let _db = Database::open(&file).unwrap();
    assert_eq!(
        std::fs::read(backup).unwrap(),
        original_backup,
        "restart must not replace the pre-upgrade backup"
    );
}

#[test]
fn project_created_before_directory_exists_is_not_duplicated_when_it_appears() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    assert_eq!(
        db.ensure_project(folder.to_str().unwrap(), false).unwrap(),
        first
    );
    assert_eq!(db.list_projects().unwrap().len(), 1);
}

#[test]
fn case_sensitive_project_identities_stay_distinct() {
    let root = tempfile::tempdir().unwrap();
    let upper = root.path().join("Alpha");
    let lower = root.path().join("alpha");
    std::fs::create_dir(&upper).unwrap();
    if lower.exists() {
        return;
    }
    std::fs::create_dir(&lower).unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    assert_ne!(
        db.ensure_project(upper.to_str().unwrap(), false).unwrap(),
        db.ensure_project(lower.to_str().unwrap(), false).unwrap()
    );
    assert_eq!(db.list_projects().unwrap().len(), 2);
}

#[test]
fn opaque_remote_project_identities_are_not_case_folded() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    for path in ["remote-project:Alpha", "remote-project:alpha"] {
        raw_project(&db, path, "Remote");
    }
    assert_eq!(db.list_projects().unwrap().len(), 2);
}

#[test]
fn historical_group_case_alias_keeps_its_context_and_remains_addressable() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let mut group = db
        .create_project_group("Kept group", &[folder.to_string_lossy().into_owned()])
        .unwrap();
    group.primary_path = alias.to_string_lossy().replace('\\', "/");
    group.roots[0].path = group.primary_path.clone();
    db.kv_set(
        "projectGroups",
        &group.id,
        &serde_json::to_value(&group).unwrap(),
    )
    .unwrap();
    db.set_project_group_instructions(&group.id, "Preserve group instructions")
        .unwrap();
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    let restored = db
        .stored_project_group_for_path(&canonical)
        .unwrap()
        .unwrap();
    assert_eq!(restored.id, group.id);
    assert_eq!(restored.primary_path, canonical);
    assert_eq!(
        db.get_project_group_instructions(&group.id).unwrap(),
        "Preserve group instructions"
    );
}

#[cfg(unix)]
#[test]
fn deleting_a_stored_symlink_path_does_not_retarget_to_another_project() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("unrelated");
    let link = root.path().join("old-link");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    let unrelated = db.ensure_project(target.to_str().unwrap(), false).unwrap();
    let selected = raw_project(&db, link.to_str().unwrap(), "Stored");
    session(&db, "selected", selected);
    for (id, project) in [("selected", selected), ("unrelated", unrelated)] {
        let path = db.project_path(project).unwrap().unwrap();
        let config = serde_json::json!({"workspacePath":path}).to_string();
        db.conn().execute("INSERT INTO scheduled_tasks(id,title,prompt,project_id,config_json,enabled,created_at,updated_at) VALUES(?1,'Task','Prompt',?2,?3,1,1,1)", params![id, project, config]).unwrap();
    }
    crate::scheduled::project::pause(&db, link.to_str().unwrap()).unwrap();
    let unrelated_enabled: bool = db
        .conn()
        .query_row(
            "SELECT enabled FROM scheduled_tasks WHERE id='unrelated'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        unrelated_enabled,
        "deleting a historical link must not pause its new target's automation"
    );
    db.kv_set(
        "projectMemory",
        link.to_str().unwrap(),
        &serde_json::json!({"content":"Selected"}),
    )
    .unwrap();
    let target_path = db.project_path(unrelated).unwrap().unwrap();
    db.kv_set(
        "projectMemory",
        &target_path,
        &serde_json::json!({"content":"Unrelated"}),
    )
    .unwrap();
    db.delete_project_memory(link.to_str().unwrap()).unwrap();
    assert!(db.kv_get("projectMemory", &target_path).unwrap().is_some());
    session(&db, "unrelated", unrelated);
    assert_eq!(
        db.project_session_ids(link.to_str().unwrap()).unwrap(),
        vec!["selected"]
    );
    assert!(db.delete_project(link.to_str().unwrap()).unwrap());
    assert!(db.get_project(unrelated).unwrap().is_some());
}

#[test]
fn path_repair_is_atomic_and_can_run_inside_an_import_transaction() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let tx = db.conn().unchecked_transaction().unwrap();
    assert_eq!(
        db.ensure_project(folder.to_str().unwrap(), false).unwrap(),
        first
    );
    tx.rollback().unwrap();
    assert_eq!(
        db.project_path(first).unwrap().unwrap(),
        alias.to_string_lossy().replace('\\', "/")
    );
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    raw_project(&db, &canonical, "Duplicate");
    db.conn().execute_batch("CREATE TRIGGER reject_merge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
    assert!(db.list_projects().is_err());
    assert_eq!(row_count(db.conn(), "projects"), 2);
    assert_eq!(
        db.project_path(first).unwrap().unwrap(),
        alias.to_string_lossy().replace('\\', "/")
    );
    db.conn()
        .execute_batch("DROP TRIGGER reject_merge")
        .unwrap();
    assert_eq!(db.list_projects().unwrap().len(), 1);
}

#[test]
fn path_migration_failure_keeps_v29_data_and_a_valid_backup() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let file = root.join("pi.sqlite");
    {
        let db = Database::open(&file).unwrap();
        let first = db.ensure_project(folder.to_str().unwrap(), false).unwrap();
        let second = raw_project(&db, alias.to_str().unwrap(), "Alias");
        session(&db, "canonical", first);
        session(&db, "alias", second);
        db.conn().execute_batch("CREATE TRIGGER reject_merge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'blocked'); END; PRAGMA user_version=29;").unwrap();
    }
    assert!(Database::open(&file).is_err());
    let conn = Connection::open(&file).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 29);
    assert_eq!(row_count(&conn, "projects"), 2);
    assert_eq!(row_count(&conn, "sessions"), 2);
    let backup = Connection::open(migration_backup_path(&file, 29)).unwrap();
    assert_eq!(row_count(&backup, "projects"), 2);
    conn.execute_batch("DROP TRIGGER reject_merge").unwrap();
    drop(conn);
    let db = Database::open(&file).unwrap();
    assert_eq!(db.list_projects().unwrap().len(), 1);
}

#[test]
fn fresh_schema_and_v29_upgrade_have_the_same_tables_and_keep_custom_data() {
    let root = tempfile::tempdir().unwrap();
    let fresh = Database::open(&root.path().join("fresh.sqlite")).unwrap();
    let upgraded_path = root.path().join("upgraded.sqlite");
    {
        let db = Database::open(&upgraded_path).unwrap();
        db.kv_set("app", "fixture", &serde_json::json!({"brand":"minih"}))
            .unwrap();
        db.conn().pragma_update(None, "user_version", 29).unwrap();
    }
    let upgraded = Database::open(&upgraded_path).unwrap();
    let schema = |conn: &Connection| -> Vec<(String, String)> {
        conn.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(schema(fresh.conn()), schema(upgraded.conn()));
    assert_eq!(
        upgraded.kv_get("app", "fixture").unwrap(),
        Some(serde_json::json!({"brand":"minih"}))
    );
    assert!(migration_backup_path(&upgraded_path, 29).exists());
}

#[test]
fn native_alias_repair_keeps_learned_memory_and_forgetting_scope() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let owner = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
    let old_path = db.project_path(owner).unwrap().unwrap();
    session(&db, "learned", owner);
    db.conn().execute("INSERT INTO memory_entries(id,scope_kind,scope_key,kind,content,status,origin,evidence,fingerprint,created_at,updated_at) VALUES('note','project',?1,'fact','Keep this note','active','explicit','user_stated','fixture-note',1,1)", params![old_path]).unwrap();
    db.conn().execute("INSERT INTO memory_tombstones(scope_kind,scope_key,fingerprint,source_session_id,source_message_ids,created_at) VALUES('project',?1,'forgotten','learned','[\"source-message\"]',1)", params![old_path]).unwrap();
    db.conn().execute("INSERT INTO memory_session_state(session_id,scope_kind,scope_key,cursor_seq) VALUES('learned','project',?1,7)", params![old_path]).unwrap();
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    assert_eq!(db.ensure_project(&canonical, false).unwrap(), owner);
    for table in [
        "memory_entries",
        "memory_tombstones",
        "memory_session_state",
    ] {
        let key: String = db
            .conn()
            .query_row(&format!("SELECT scope_key FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(key, canonical, "{table} must follow its original project");
    }
    let cursor: i64 = db
        .conn()
        .query_row("SELECT cursor_seq FROM memory_session_state", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(cursor, 7);
}
