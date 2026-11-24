//! A delivery a turn that was already running accepted as steering input: its
//! claim, its settlement, and the transcript provenance that follows the turn
//! rather than the row's status (schema v46, ADR 0265).
//!
//! `tests.rs` keeps the delivery lifecycle it grew up with; this file exists so
//! neither test module crosses the module budget.

use super::tests::{send, session, ui};
use super::*;

/// Flag one ledger row as an existing delivery of `kind`, without a turn.
fn queued(db: &Database, source: &str, target: &str, key: &str, kind: &str) -> Message {
    send_record(
        db,
        &json!({"sourceSessionId":source,"pluginId":"pi.session-orchestrator",
        "content":"Review the change","idempotencyKey":key,"notifyOnCompletion":true}),
        target,
        kind,
    )
    .unwrap()
}

fn pending(db: &Database) -> Vec<String> {
    repository::pending_dispatch(db)
        .unwrap()
        .into_iter()
        .map(|message| message.id)
        .collect()
}

fn claim(db: &Database, message_id: &str, session_id: &str, turn_id: &str) -> Result<Value> {
    handle(
        db,
        "session.collaboration.steered",
        &json!({"messageId":message_id,"sessionId":session_id,"turnId":turn_id}),
    )
}

#[test]
fn a_steered_completion_is_claimed_and_never_dispatched_again() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    // A finished task writes its receipt to the parent, where nothing is running.
    let task = send(&db, &parent, &child, "work");
    let work = begin_turn(&db, &child, &task.id, None, None).unwrap();
    sessions::end_turn(&db, &work, "completed", None, None, false).unwrap();
    let receipt = settle_turn(&db, &work).unwrap().unwrap();
    assert_eq!(receipt.kind, "completion");
    assert!(pending(&db).contains(&receipt.id));

    // The parent is busy in a turn of its own and folds the receipt into it.
    let host_turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let claimed = claim(&db, &receipt.id, &parent, &host_turn).unwrap();
    assert_eq!(claimed["message"]["status"], "completed");
    assert_eq!(claimed["message"]["kind"], "completion");
    assert_eq!(claimed["message"]["hostTurnId"], host_turn.as_str());
    // The whole fix: a delivered receipt is no longer waiting for a turn, so the
    // next drain cannot hand it to the person a second time.
    assert!(!pending(&db).contains(&receipt.id));

    // Repeating the same claim is not a second delivery and writes no receipt.
    let again = claim(&db, &receipt.id, &parent, &host_turn).unwrap();
    assert_eq!(again["message"]["status"], "completed");
    let receipts: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_collaboration_messages WHERE reply_to_message_id=?1",
            params![receipt.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 0);

    // A turn that is no longer running cannot carry anything.
    sessions::end_turn(&db, &host_turn, "completed", None, None, false).unwrap();
    let stale = claim(&db, &receipt.id, &parent, &host_turn).unwrap_err();
    assert!(stale.to_string().starts_with("PERMISSION_DENIED"));
}

#[test]
fn a_steered_delivery_settles_with_the_turn_that_carried_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let notice = queued(&db, &parent, &child, "carried", "stage");
    assert!(pending(&db).contains(&notice.id));

    // The child is already working, so the notice rides that turn instead of
    // starting one of its own.
    let host_turn = sessions::begin_turn(&db, &child, None, None).unwrap();
    let claimed = claim(&db, &notice.id, &child, &host_turn).unwrap();
    assert_eq!(claimed["message"]["status"], "running");
    assert_eq!(claimed["message"]["hostTurnId"], host_turn.as_str());
    assert!(claimed["message"].get("turnId").is_none());
    assert!(!pending(&db).contains(&notice.id));

    // The carrying turn settles it, and the sender hears about it once.
    sessions::end_turn(&db, &host_turn, "completed", None, None, false).unwrap();
    let receipt = settle_turn(&db, &host_turn).unwrap().unwrap();
    assert_eq!(receipt.kind, "completion");
    assert_eq!(receipt.target_session_id, parent);
    let settled = get(&db, &notice.id).unwrap().unwrap();
    assert_eq!(settled.status, "completed");
    assert!(settled.turn_id.is_none());
    assert_eq!(settled.host_turn_id.as_deref(), Some(host_turn.as_str()));
    // Settling again finds nothing left to close.
    assert!(settle_turn(&db, &host_turn).unwrap().is_none());

    // A settled row cannot be claimed for another turn.
    let next = sessions::begin_turn(&db, &child, None, None).unwrap();
    let conflict = claim(&db, &notice.id, &child, &next).unwrap_err();
    assert!(conflict.to_string().starts_with("CONFLICT"));
}

#[test]
fn a_steered_claim_is_scoped_to_its_session() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let other = session(&db, "Other");
    let notice = queued(&db, &parent, &child, "scoped", "stage");
    let host_turn = sessions::begin_turn(&db, &other, None, None).unwrap();
    let denied = claim(&db, &notice.id, &other, &host_turn).unwrap_err();
    assert!(denied.to_string().starts_with("PERMISSION_DENIED"));
    // The row is untouched and still waiting for its own turn.
    assert_eq!(get(&db, &notice.id).unwrap().unwrap().status, "queued");
    assert!(pending(&db).contains(&notice.id));
}

/// The steering row the runtime writes for a delivery it was handed: the input
/// *is* the delivery, so it carries the ledger row's identity and body.
fn steered(content: &str, message_id: &str) -> sessions::UiMessage {
    let mut message = ui("user", content);
    message.steering = Some(true);
    message.session_message = Some(json!({"messageId":message_id}));
    message
}

#[test]
fn a_claimed_completion_still_persists_its_transcript_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    // A finished task writes its receipt to the parent.
    let task = send(&db, &parent, &child, "work");
    let work = begin_turn(&db, &child, &task.id, None, None).unwrap();
    sessions::end_turn(&db, &work, "completed", None, None, false).unwrap();
    let receipt = settle_turn(&db, &work).unwrap().unwrap();

    // The parent is busy, `send now` folds the receipt in, and the claim settles
    // it immediately. The runtime only writes the transcript row at its next
    // boundary — after the claim, which is the normal order, not a corner case.
    let host_turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    claim(&db, &receipt.id, &parent, &host_turn).unwrap();
    assert_eq!(get(&db, &receipt.id).unwrap().unwrap().status, "completed");
    let row = steered(&receipt.content, &receipt.id);
    sessions::append_message(&db, &parent, &row, Some(&host_turn))
        .expect("a settled receipt the carrying turn accepted must still persist");

    let detail = sessions::get_session(&db, &parent).unwrap().unwrap();
    let persisted = detail
        .messages
        .iter()
        .find(|m| m.id == row.id)
        .expect("the steered receipt reached the transcript");
    let origin = persisted.session_message.clone().unwrap();
    assert_eq!(origin["messageId"], receipt.id.as_str());
    assert_eq!(origin["kind"], "completion");
    assert_eq!(origin["sourceSessionId"], child.as_str());
}

#[test]
fn a_delivery_claimed_and_running_still_persists_its_transcript_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let notice = queued(&db, &parent, &child, "carried", "stage");
    let host_turn = sessions::begin_turn(&db, &child, None, None).unwrap();
    claim(&db, &notice.id, &child, &host_turn).unwrap();
    assert_eq!(get(&db, &notice.id).unwrap().unwrap().status, "running");

    let row = steered(&notice.content, &notice.id);
    sessions::append_message(&db, &child, &row, Some(&host_turn)).unwrap();
    let detail = sessions::get_session(&db, &child).unwrap().unwrap();
    let persisted = detail.messages.iter().find(|m| m.id == row.id).unwrap();
    assert_eq!(
        persisted.session_message.as_ref().unwrap()["messageId"],
        notice.id.as_str()
    );
}

#[test]
fn a_delivery_appended_before_the_claim_still_persists() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let notice = queued(&db, &parent, &child, "unclaimed", "stage");
    let host_turn = sessions::begin_turn(&db, &child, None, None).unwrap();

    // A runtime that writes the row first: the ledger still says `queued`.
    let row = steered(&notice.content, &notice.id);
    sessions::append_message(&db, &child, &row, Some(&host_turn)).unwrap();
    claim(&db, &notice.id, &child, &host_turn).unwrap();
    assert_eq!(get(&db, &notice.id).unwrap().unwrap().status, "running");
}

#[test]
fn a_steered_delivery_cannot_borrow_another_turn_another_body_or_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let notice = queued(&db, &parent, &child, "scoped-write", "stage");
    let host_turn = sessions::begin_turn(&db, &child, None, None).unwrap();
    claim(&db, &notice.id, &child, &host_turn).unwrap();

    // Another body under the same row's identity.
    let forged = steered("something else entirely", &notice.id);
    assert!(
        sessions::append_message(&db, &child, &forged, Some(&host_turn))
            .unwrap_err()
            .to_string()
            .starts_with("PERMISSION_DENIED")
    );

    // A delivery carries no attachments, exactly like a delivery's own turn.
    let mut attached = steered(&notice.content, &notice.id);
    attached.attachments = Some(vec![sessions::MessageAttachment {
        kind: "file".into(),
        name: "notes.txt".into(),
        reference: "/tmp/notes.txt".into(),
        mime_type: None,
        size: None,
        text: None,
        inline_path: None,
    }]);
    assert!(
        sessions::append_message(&db, &child, &attached, Some(&host_turn))
            .unwrap_err()
            .to_string()
            .starts_with("PERMISSION_DENIED")
    );

    // A turn that did not carry it cannot attach the row.
    sessions::end_turn(&db, &host_turn, "completed", None, None, false).unwrap();
    let later_turn = sessions::begin_turn(&db, &child, None, None).unwrap();
    let late = steered(&notice.content, &notice.id);
    assert!(
        sessions::append_message(&db, &child, &late, Some(&later_turn))
            .unwrap_err()
            .to_string()
            .starts_with("PERMISSION_DENIED")
    );
}
