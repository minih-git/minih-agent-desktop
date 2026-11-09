//! Conversation archive contract tests (ADR conversation-archive).

use serde_json::{json, Value};

use crate::conversation_archive::project_identity::normalize_remote;
use crate::conversation_archive::projection::{project_transcript, ConversationTurn};
use crate::db::Database;
use crate::memory::secrets::redact_fragments;
use crate::transcripts::{CompactionRecord, MessageRecord};

fn text_record(id: &str, role: &str, text: &str, created_at: &str) -> MessageRecord {
    MessageRecord {
        id: id.into(),
        role: role.into(),
        tool_name: None,
        is_error: false,
        blocks: json!([{ "type": "text", "text": text }]),
        meta: None,
        created_at: created_at.into(),
    }
}

fn tool_record(id: &str, name: &str, args: Value, created_at: &str) -> MessageRecord {
    MessageRecord {
        id: id.into(),
        role: "tool".into(),
        tool_name: Some(name.into()),
        is_error: false,
        blocks: json!([{
            "type": "tool_call",
            "name": name,
            "args": args,
            "result": { "text": "TOOL OUTPUT MUST NOT LEAVE" }
        }]),
        meta: None,
        created_at: created_at.into(),
    }
}

fn compaction(through: &str, created_at: &str) -> CompactionRecord {
    CompactionRecord {
        id: format!("c-{through}"),
        summary: "an earlier summary".into(),
        first_kept_message_id: Some(through.into()),
        through_message_id: through.into(),
        tokens_before: 1000,
        usage: None,
        retained_tail: None,
        details: None,
        provider_id: None,
        model_id: None,
        created_at: created_at.into(),
    }
}

fn turn_lines(turn: &ConversationTurn) -> Vec<String> {
    turn.tools.iter().map(|tool| tool.line.clone()).collect()
}

#[test]
fn thinking_attachments_and_tool_results_never_reach_the_projection() {
    let messages = vec![
        MessageRecord {
            id: "u1".into(),
            role: "user".into(),
            tool_name: None,
            is_error: false,
            blocks: json!([
                { "type": "text", "text": "ship the fix" },
                { "type": "attachment", "kind": "file", "name": "a.ts", "text": "ATTACHMENT BODY" }
            ]),
            meta: None,
            created_at: "2026-11-09T10:00:00Z".into(),
        },
        MessageRecord {
            id: "a1".into(),
            role: "assistant".into(),
            tool_name: None,
            is_error: false,
            blocks: json!([
                { "type": "thinking", "text": "THINKING TRACE" },
                { "type": "text", "text": "fixing it" }
            ]),
            meta: None,
            created_at: "2026-11-09T10:01:00Z".into(),
        },
        tool_record(
            "t1",
            "Bash",
            json!({ "command": "git status --short" }),
            "2026-11-09T10:02:00Z",
        ),
        MessageRecord {
            id: "s1".into(),
            role: "system".into(),
            tool_name: None,
            is_error: false,
            blocks: json!([{ "type": "text", "text": "SYSTEM PROMPT" }]),
            meta: None,
            created_at: "2026-11-09T10:03:00Z".into(),
        },
    ];
    let turns = project_transcript(&messages, &[]);
    assert_eq!(turns.len(), 1);
    let rendered = serde_json::to_string(&turns).unwrap();
    for forbidden in [
        "THINKING TRACE",
        "ATTACHMENT BODY",
        "TOOL OUTPUT MUST NOT LEAVE",
        "SYSTEM PROMPT",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "{forbidden} leaked: {rendered}"
        );
    }
    assert_eq!(turns[0].user, "ship the fix");
    assert_eq!(turns[0].assistant, "fixing it");
    assert_eq!(
        turn_lines(&turns[0]),
        vec!["Bash `command: git status --short`".to_string()]
    );
}

#[test]
fn every_tool_family_gets_its_key_argument_and_failures_are_marked() {
    let messages = vec![
        text_record("u1", "user", "do the work", "2026-11-09T10:00:00Z"),
        tool_record(
            "t1",
            "Bash",
            json!({ "command": "pnpm test" }),
            "2026-11-09T10:01:00Z",
        ),
        tool_record(
            "t2",
            "Read",
            json!({ "path": "apps/desktop/src/x.ts" }),
            "2026-11-09T10:02:00Z",
        ),
        tool_record(
            "t3",
            "Edit",
            json!({ "path": "apps/desktop/src/y.ts" }),
            "2026-11-09T10:03:00Z",
        ),
        tool_record(
            "t4",
            "Grep",
            json!({ "pattern": "TODO", "path": "crates" }),
            "2026-11-09T10:04:00Z",
        ),
        tool_record(
            "t5",
            "Glob",
            json!({ "pattern": "**/*.rs" }),
            "2026-11-09T10:05:00Z",
        ),
        tool_record(
            "t6",
            "Skill",
            json!({ "id": "git-commit" }),
            "2026-11-09T10:06:00Z",
        ),
        {
            let mut record = tool_record(
                "t7",
                "Custom",
                json!({ "anything": "value", "other": 1 }),
                "2026-11-09T10:07:00Z",
            );
            record.is_error = true;
            record.blocks = json!([{
                "type": "tool_call",
                "name": "Custom",
                "args": { "anything": "value" },
                "status": "error",
                "isError": true
            }]);
            record
        },
    ];
    let turns = project_transcript(&messages, &[]);
    let lines = turn_lines(&turns[0]);
    assert_eq!(lines[0], "Bash `command: pnpm test`");
    assert_eq!(lines[1], "Read `path: apps/desktop/src/x.ts`");
    assert_eq!(lines[2], "Edit `path: apps/desktop/src/y.ts`");
    assert_eq!(lines[3], "Grep `pattern: TODO crates`");
    assert_eq!(lines[4], "Glob `pattern: **/*.rs`");
    assert_eq!(lines[5], "Skill `id: git-commit`");
    // The fallback keeps the argument JSON, so a tool added later still records
    // what it was pointed at.
    assert!(lines[6].starts_with("Custom `args: {"), "{}", lines[6]);
    assert!(lines[6].ends_with('✗'), "{}", lines[6]);
    assert!(turns[0].tools[6].is_error);
}

#[test]
fn a_long_argument_is_truncated_to_one_bounded_line() {
    let long = "x".repeat(2_000);
    let messages = vec![
        text_record("u1", "user", "go", "2026-11-09T10:00:00Z"),
        tool_record(
            "t1",
            "Bash",
            json!({ "command": long }),
            "2026-11-09T10:01:00Z",
        ),
    ];
    let turns = project_transcript(&messages, &[]);
    let line = &turns[0].tools[0].line;
    assert!(line.contains('…'), "truncation marker missing: {line}");
    assert!(!line.contains('\n'));
    assert!(line.chars().count() <= 200);
}

#[test]
fn credentials_are_replaced_by_fragments_not_dropped() {
    let messages = vec![text_record(
        "u1",
        "user",
        "run it with sk-ant-abcdefghijklmnopqrst then check",
        "2026-11-09T10:00:00Z",
    )];
    let turns = project_transcript(&messages, &[]);
    let user = &turns[0].user;
    assert!(user.contains("[REDACTED:provider_token]"), "{user}");
    assert!(
        user.contains("then check"),
        "the rest of the line must survive: {user}"
    );
    assert!(!user.contains("sk-ant-abcdefghijklmnopqrst"));
}

#[test]
fn redaction_handles_url_credentials_and_leaves_clean_text_alone() {
    let redacted = redact_fragments("clone https://user:s3cret@example.com/repo.git now");
    assert!(
        redacted.contains("[REDACTED:url_credentials]"),
        "{redacted}"
    );
    assert!(redacted.ends_with(" now"));
    assert_eq!(
        redact_fragments("nothing secret here"),
        "nothing secret here"
    );
    assert_eq!(redact_fragments(""), "");
}

#[test]
fn a_compaction_marker_marks_the_turn_it_belongs_to() {
    let messages = vec![
        text_record("u1", "user", "first", "2026-11-09T10:00:00Z"),
        text_record("a1", "assistant", "done", "2026-11-09T10:01:00Z"),
        text_record("u2", "user", "second", "2026-11-09T10:30:00Z"),
    ];
    let turns = project_transcript(&messages, &[compaction("a1", "2026-11-09T10:30:00Z")]);
    assert_eq!(turns.len(), 2);
    assert!(turns[0].compaction.is_none());
    let marker = turns[1].compaction.as_deref().unwrap();
    assert!(
        marker.starts_with("compaction 2026-11-09 10:30"),
        "{marker}"
    );
    assert!(marker.contains("kept from a1"));
}

#[test]
fn remote_urls_normalize_to_one_identity_per_repository() {
    let cases = [
        (
            "https://github.com/minih/repo.git",
            Some("github.com/minih/repo"),
        ),
        (
            "https://user:s3cret@github.com/minih/repo.git",
            Some("github.com/minih/repo"),
        ),
        (
            "git@github.com:minih/repo.git",
            Some("github.com/minih/repo"),
        ),
        (
            "ssh://git@GitHub.com/minih/repo",
            Some("github.com/minih/repo"),
        ),
        (
            "https://gitea.example.com:8443/team/group/repo.git",
            Some("gitea.example.com/group/repo"),
        ),
        ("", None),
    ];
    for (url, expected) in cases {
        assert_eq!(normalize_remote(url).as_deref(), expected, "for {url:?}");
    }
    // No credential text may survive normalization, in any shape.
    let leaked = normalize_remote("https://user:s3cret@example.com/o/r.git").unwrap();
    assert!(!leaked.contains("s3cret"));
    assert!(!leaked.contains("user"));
}

#[test]
fn project_identity_reads_a_real_git_config_and_follows_a_worktree_file() {
    let dir = tempfile::tempdir().unwrap();
    let main_repo = dir.path().join("main");
    std::fs::create_dir_all(main_repo.join(".git/worktrees/wt")).unwrap();
    std::fs::write(
        main_repo.join(".git/config"),
        "[core]\n\trepositoryformatversion = 0\n[remote \"origin\"]\n\turl = https://token:secret@git.example.com/team/app.git\n",
    )
    .unwrap();
    let worktree = dir.path().join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(
        worktree.join(".git"),
        format!(
            "gitdir: {}\n",
            main_repo.join(".git/worktrees/wt").display()
        ),
    )
    .unwrap();
    std::fs::write(main_repo.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();

    let identity = crate::conversation_archive::project_identity::project_identity(
        "app",
        &worktree.display().to_string(),
    );
    assert_eq!(
        identity.git_remote.as_deref(),
        Some("git.example.com/team/app")
    );
    let rendered = serde_json::to_string(&identity).unwrap();
    assert!(!rendered.contains("token"));
    assert!(!rendered.contains("secret"));
}

fn open_db(dir: &tempfile::TempDir) -> Database {
    Database::open(&dir.path().join("pi.sqlite")).unwrap()
}

/// Create one session row plus an index row, which is all the archive reads for
/// ordering and identity.
fn seed_session(db: &Database, id: &str, title: &str, updated_at: i64) {
    db.conn()
        .execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, last_seq)
             VALUES (?1, ?2, ?3, ?4, 0)",
            rusqlite::params![id, title, updated_at - 1_000, updated_at],
        )
        .unwrap();
}

#[test]
fn the_migration_adds_both_tables_and_keeps_existing_rows() {
    let dir = tempfile::tempdir().unwrap();
    {
        let db = open_db(&dir);
        seed_session(&db, "s1", "kept", 1_700_000_000_000);
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::db::SCHEMA_VERSION);
        let tables: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'table'
                    AND name IN ('conversation_summaries', 'conversation_archive_tombstones')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
    }
    // Re-opening an existing v29 database is a no-op, and the session survives.
    let db = open_db(&dir);
    let title: String = db
        .conn()
        .query_row("SELECT title FROM sessions WHERE id = 's1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(title, "kept");
    assert_eq!(
        db.conversation_archive_queue(10).unwrap(),
        vec!["s1".to_string()]
    );
}

#[test]
fn a_legacy_v26_database_gains_the_tables_and_backfills_every_session() {
    let dir = tempfile::tempdir().unwrap();
    {
        // A v26 file: the pre-archive schema with one session and no archive
        // tables. `SCHEMA_VERSION` covers the v26 -> v29 chain on open.
        let db = open_db(&dir);
        seed_session(&db, "s1", "old", 1_000);
        db.conn()
            .execute_batch(
                "DROP TABLE conversation_summaries; DROP TABLE conversation_archive_tombstones;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 26).unwrap();
    }
    let db = open_db(&dir);
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::db::SCHEMA_VERSION);
    let state = db.conversation_summary_state("s1").unwrap();
    assert!(
        state.is_none(),
        "a legacy session has never been summarized"
    );
    assert_eq!(
        db.conversation_archive_queue(10).unwrap(),
        vec!["s1".to_string()]
    );
}

/// The released 1.3.x schema is v28 (keep-warm), so the archive step must land
/// on top of it: a user who is already on v28 upgrades without losing a row.
#[test]
fn a_released_v28_database_gains_the_tables_and_keeps_every_row() {
    let dir = tempfile::tempdir().unwrap();
    {
        // A v28 file: the archive tables are absent, everything else is the
        // schema that was already shipped.
        let db = open_db(&dir);
        seed_session(&db, "s1", "shipped", 1_700_000_000_000);
        db.conn()
            .execute_batch(
                "DROP TABLE conversation_summaries; DROP TABLE conversation_archive_tombstones;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 28).unwrap();
        let missing: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'table'
                    AND name IN ('conversation_summaries', 'conversation_archive_tombstones')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(missing, 0, "the v28 file has no archive tables");
    }
    let db = open_db(&dir);
    assert_eq!(crate::db::SCHEMA_VERSION, 29);
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 29);
    let tables: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
              WHERE type = 'table'
                AND name IN ('conversation_summaries', 'conversation_archive_tombstones')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 2, "one additive step creates both tables");
    let title: String = db
        .conn()
        .query_row("SELECT title FROM sessions WHERE id = 's1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(title, "shipped");
    assert_eq!(
        db.conversation_archive_queue(10).unwrap(),
        vec!["s1".to_string()],
        "an upgraded session is queued for its first summary"
    );
}

#[test]
fn the_lease_cursor_and_revision_move_only_for_the_holder() {
    let dir = tempfile::tempdir().unwrap();
    let db = open_db(&dir);
    seed_session(&db, "s1", "leased", 5_000);

    let claimed = db
        .claim_conversation_summary("s1", "owner-a", 60_000)
        .unwrap()
        .expect("first claim wins");
    assert_eq!(claimed.revision, 0);
    assert!(db
        .claim_conversation_summary("s1", "owner-b", 60_000)
        .unwrap()
        .is_none());

    let summary = crate::conversation_archive::repo::ConversationSummary {
        goal: "Ship the archive".into(),
        decisions: vec!["one row per session".into()],
        outcomes: vec![],
        files: vec![],
        open_items: vec![],
        tags: vec![],
    };
    // A run that does not hold the lease cannot store anything.
    assert!(db
        .complete_conversation_summary("s1", "owner-b", 4, "p/m", &summary)
        .unwrap()
        .is_none());
    let stored = db
        .complete_conversation_summary("s1", "owner-a", 4, "p/m", &summary)
        .unwrap()
        .expect("the holder stores");
    assert_eq!(stored.revision, 1);
    assert_eq!(stored.covered_seq, 4);
    assert_eq!(stored.summary, Some(summary));

    // The backfill queue no longer offers a summarized session.
    assert!(db.conversation_archive_queue(10).unwrap().is_empty());
}

#[test]
fn a_failed_run_keeps_the_cursor_and_counts_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let db = open_db(&dir);
    seed_session(&db, "s1", "failing", 5_000);
    db.claim_conversation_summary("s1", "owner", 60_000)
        .unwrap()
        .unwrap();
    let failed = db
        .fail_conversation_summary("s1", "owner", "MODEL_CALL_FAILED")
        .unwrap()
        .unwrap();
    assert_eq!(failed.attempts, 1);
    assert_eq!(failed.covered_seq, 0);
    assert_eq!(failed.last_error.as_deref(), Some("MODEL_CALL_FAILED"));
    assert_eq!(failed.revision, 0);
    // The lease is released, so the retry does not wait for it to expire.
    assert!(db
        .claim_conversation_summary("s1", "owner", 60_000)
        .unwrap()
        .is_some());
}

#[test]
fn an_excluded_session_cannot_be_claimed() {
    let dir = tempfile::tempdir().unwrap();
    let db = open_db(&dir);
    seed_session(&db, "s1", "excluded", 5_000);
    db.set_memory_session_excluded("s1", true).unwrap();
    assert!(db
        .claim_conversation_summary("s1", "owner", 60_000)
        .unwrap()
        .is_none());
    assert!(db.conversation_archive_queue(10).unwrap().is_empty());
}

#[test]
fn the_feed_pages_forward_and_reports_removals() {
    let dir = tempfile::tempdir().unwrap();
    let db = open_db(&dir);
    seed_session(&db, "s1", "one", 1_000);
    seed_session(&db, "s2", "two", 2_000);
    let summary = crate::conversation_archive::repo::ConversationSummary {
        goal: "done".into(),
        ..Default::default()
    };
    for id in ["s1", "s2"] {
        db.claim_conversation_summary(id, "owner", 60_000).unwrap();
        db.complete_conversation_summary(id, "owner", 3, "p/m", &summary)
            .unwrap();
    }
    // A soft-deleted session still appears, marked removed.
    db.conn()
        .execute(
            "UPDATE sessions SET deleted_at = 3_000, updated_at = 3_000 WHERE id = 's2'",
            [],
        )
        .unwrap();

    let first = crate::conversation_archive::feed::changes_page(&db, None, 1).unwrap();
    assert_eq!(first["enabled"], true);
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["items"][0]["sessionId"], "s1");
    assert_eq!(first["items"][0]["removed"], false);
    assert_eq!(first["items"][0]["summaryRevision"], 1);

    let cursor = first["nextCursor"].as_str().unwrap().to_string();
    let second = crate::conversation_archive::feed::changes_page(&db, Some(&cursor), 10).unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["items"][0]["sessionId"], "s2");
    assert_eq!(second["items"][0]["removed"], true);

    let cursor = second["nextCursor"].as_str().unwrap().to_string();
    let third = crate::conversation_archive::feed::changes_page(&db, Some(&cursor), 10).unwrap();
    assert_eq!(third["items"].as_array().unwrap().len(), 0);
    assert!(third["nextCursor"].is_null());
}

#[test]
fn a_purged_session_is_delivered_once_from_the_tombstone() {
    let dir = tempfile::tempdir().unwrap();
    let db = open_db(&dir);
    seed_session(&db, "s1", "purged", 1_000);
    crate::conversation_archive::record_deletion(&db, "s1").unwrap();
    db.conn()
        .execute("DELETE FROM sessions WHERE id = 's1'", [])
        .unwrap();

    let page = crate::conversation_archive::feed::changes_page(&db, None, 10).unwrap();
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["sessionId"], "s1");
    assert_eq!(items[0]["removed"], true);
    let cursor = page["nextCursor"].as_str().unwrap().to_string();

    // Delivered once: the tombstone is drained by the page that carried it.
    let again = crate::conversation_archive::feed::changes_page(&db, Some(&cursor), 10).unwrap();
    assert_eq!(again["items"].as_array().unwrap().len(), 0);
}

#[test]
fn a_session_without_a_summary_is_not_listed_until_it_has_one() {
    let dir = tempfile::tempdir().unwrap();
    let db = open_db(&dir);
    seed_session(&db, "s1", "pending", 1_000);
    let page = crate::conversation_archive::feed::changes_page(&db, None, 10).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 0);
}

fn ui(role: &str, content: &str) -> crate::sessions::UiMessage {
    serde_json::from_value(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "role": role,
        "content": content,
        "createdAt": crate::db::ms_to_ts(crate::db::now_ms()),
    }))
    .unwrap()
}

/// Settle a turn, so the next one may open: the host allows one running turn per
/// session.
fn settle(db: &Database, turn: &str) {
    db.conn()
        .execute(
            "UPDATE turns SET status = 'completed', ended_at = ?2 WHERE id = ?1",
            rusqlite::params![turn, crate::db::now_ms()],
        )
        .unwrap();
}

fn append_in_turn(db: &Database, session_id: &str, role: &str, content: &str) -> String {
    let turn = crate::sessions::begin_turn(db, session_id, None, None).unwrap();
    crate::sessions::append_message(db, session_id, &ui(role, content), Some(&turn)).unwrap();
    settle(db, &turn);
    turn
}

#[test]
fn the_summary_input_reads_past_a_compaction_and_bounds_the_text() {
    let dir = tempfile::tempdir().unwrap();
    let db = open_db(&dir);
    let session =
        crate::sessions::create_session(&db, Some("compacted".into()), None, None, None, None)
            .unwrap();
    let turn = append_in_turn(&db, &session.id, "user", "before the compaction");
    let message_id: String = db
        .conn()
        .query_row(
            "SELECT id FROM messages WHERE session_id = ?1 AND turn_id = ?2",
            rusqlite::params![session.id, turn],
            |row| row.get(0),
        )
        .unwrap();
    // This application's compaction appends a checkpoint and keeps the messages,
    // so a summary that reads from its cursor still sees the earlier text.
    crate::sessions::append_compaction(
        &db,
        &session.id,
        &compaction(&message_id, &crate::db::ms_to_ts(crate::db::now_ms())),
    )
    .unwrap();
    append_in_turn(&db, &session.id, "user", "after the compaction");

    let outcome = db.conversation_archive_input(&session.id).unwrap().unwrap();
    let crate::conversation_archive::repo::ConversationArchiveInputOutcome::Input(input) = outcome
    else {
        panic!("expected an input");
    };
    assert!(
        input.text.contains("before the compaction"),
        "a compaction must not hide earlier text: {}",
        input.text
    );
    assert!(input.text.contains("after the compaction"));
    assert!(input.text.contains("[compaction "), "{}", input.text);
    assert!(input.bytes <= crate::conversation_archive::repo::ARCHIVE_INPUT_MAX_BYTES);

    // Once a summary covers everything, the run has nothing left to do. A
    // second turn after the cursor brings the session back.
    let summary = crate::conversation_archive::repo::ConversationSummary {
        goal: "covered".into(),
        ..Default::default()
    };
    db.claim_conversation_summary(&session.id, "owner", 60_000)
        .unwrap()
        .unwrap();
    db.complete_conversation_summary(&session.id, "owner", input.next_cursor_seq, "p/m", &summary)
        .unwrap();
    let crate::conversation_archive::repo::ConversationArchiveInputOutcome::Skipped(skip) =
        db.conversation_archive_input(&session.id).unwrap().unwrap()
    else {
        panic!("a covered session has nothing to summarize");
    };
    assert_eq!(skip, "up-to-date");
    append_in_turn(&db, &session.id, "user", "a later turn");
    let crate::conversation_archive::repo::ConversationArchiveInputOutcome::Input(again) =
        db.conversation_archive_input(&session.id).unwrap().unwrap()
    else {
        panic!("a new message must reopen the range");
    };
    assert_eq!(again.cursor_seq, input.next_cursor_seq);
    assert!(again.text.contains("a later turn"));
    assert!(
        again.previous.is_some(),
        "the previous summary is the digest"
    );
}

#[test]
fn the_rpc_serves_the_projection_and_refuses_bad_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = crate::state::AppState::open(dir.path()).unwrap();
    state.handshook = true;

    let page = crate::conversation_archive::handle(
        &state,
        "plugin.conversations.changes",
        json!({ "limit": 5 }),
    )
    .unwrap();
    assert_eq!(page["enabled"], true);

    let error = crate::conversation_archive::handle(
        &state,
        "plugin.conversations.changes",
        json!({ "limit": 500 }),
    )
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");

    let missing = crate::conversation_archive::handle(
        &state,
        "plugin.conversations.transcript",
        json!({ "sessionId": "nope" }),
    );
    assert_eq!(missing.unwrap_err().data.unwrap()["errorCode"], "NOT_FOUND");

    let summary = crate::conversation_archive::handle(
        &state,
        "plugin.conversations.summary",
        json!({ "sessionId": "nope" }),
    )
    .unwrap();
    assert_eq!(summary, Value::Null);
}
