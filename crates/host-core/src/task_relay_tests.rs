//! Relay between steps: the card edge, the handoff, and what an abandoned step
//! does to the one behind it (employee mode 0.5 slice 7).
//!
//! Everything here is database work except the workspace test, which needs real
//! git: a chain is about branches, and the only honest way to prove "the next
//! step starts where this one stopped" is to look at the commits.

use serde_json::{json, Value};

use crate::db::Database;
use crate::session_collaboration::drafts::{self, Draft};
use crate::sessions;
use crate::task_relay;
use crate::tasks;

/// A database and one registered project.
///
/// The project is a real directory because a card that names a repository is
/// only confirmable when this computer has a checkout of it, and resolving a
/// path is what that check does.
fn database() -> (tempfile::TempDir, Database, String) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let path = std::fs::canonicalize(&project)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    crate::db::upsert_project_row(db.conn(), &path, false).unwrap();
    (dir, db, path)
}

fn session(db: &Database, title: &str, role: Option<&str>, mode: &str) -> String {
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(title.into()),
            mode: Some("agent".into()),
            permission_mode: Some(mode.into()),
            role: role.map(str::to_owned),
            bot_profile_json: role.map(|_| {
                format!(r#"{{"name":"{title}","permissionMode":"{mode}","observe":false}}"#)
            }),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn card(goal: &str) -> Value {
    json!({
        "goal": goal,
        "criteria": [{"id": "c1", "text": "The step is done"}],
        "boundaries": ["Stay inside the repository"],
        "permissionMode": "accept-edits",
        "readOnly": false,
        "mustAsk": [],
        "risk": "medium",
        "repo": {"origin": "github.com/minih-git/minih-agent-desktop"},
    })
}

fn propose(
    db: &Database,
    steward: &str,
    target: &str,
    goal: &str,
    batch: &str,
    after: Option<&str>,
) -> Draft {
    let result = drafts::propose(
        db,
        &json!({
            "sessionId": steward,
            "targetSessionId": target,
            "sourceUtterance": "把这件事分三步做完",
            "batchId": batch,
            "card": card(goal),
            "after": after,
        }),
    )
    .unwrap();
    serde_json::from_value(result["draft"].clone()).unwrap()
}

fn propose_fails(
    db: &Database,
    steward: &str,
    target: &str,
    goal: &str,
    batch: &str,
    after: &str,
) -> String {
    let error = drafts::propose(
        db,
        &json!({
            "sessionId": steward,
            "targetSessionId": target,
            "sourceUtterance": "把这件事分三步做完",
            "batchId": batch,
            "card": card(goal),
            "after": after,
        }),
    )
    .unwrap_err();
    error.to_string()
}

fn confirm(db: &Database, draft: &Draft, key: &str, project: &str) -> tasks::Task {
    let result = drafts::confirm(
        db,
        drafts::ConfirmRequest {
            draft_id: &draft.id,
            card_hash: &draft.card_hash,
            confirmed_by: drafts::CONFIRMED_BY_USER,
            host_id: Some("mac-mini"),
            device_id: None,
            policy_version: "steward-1",
            notify_on_completion: false,
            idempotency_key: key,
            project_path: Some(project),
        },
    )
    .unwrap();
    let task_id = result["task"]["id"].as_str().unwrap();
    tasks::get_task(db, task_id).unwrap().unwrap()
}

fn reread(db: &Database, task_id: &str) -> tasks::Task {
    tasks::get_task(db, task_id).unwrap().unwrap()
}

/// **The chain is declared by the cards, so the edge is checked when it is made.**
#[test]
fn a_card_can_only_follow_a_card_from_the_same_batch() {
    let (_dir, db, _project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Add the column", "turn-1", None);
    let message = propose_fails(&db, &steward, &worker, "Backfill it", "turn-2", &first.id);
    assert!(
        message.contains("same turn"),
        "the refusal does not name the batch: {message}"
    );
}

/// **Two repositories can never be chained**, because a relay is one branch
/// continued: the second step's base has to be in the same history.
#[test]
fn a_relay_stays_inside_one_repository() {
    let (_dir, db, _project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Add the column", "turn-1", None);
    let mut other = card("Backfill it");
    other["repo"] = json!({"origin": "github.com/minih-git/minih-router"});
    let error = drafts::propose(
        &db,
        &json!({
            "sessionId": steward,
            "targetSessionId": worker,
            "sourceUtterance": "把这件事分三步做完",
            "batchId": "turn-1",
            "card": other,
            "after": first.id,
        }),
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("one repository"),
        "the refusal does not name the repository: {error}"
    );
}

/// **A chain of five is the limit**, and the sixth step is refused rather than
/// accepted into a shape nothing can display.
#[test]
fn a_chain_holds_at_most_five_steps() {
    let (_dir, db, _project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let mut previous = propose(&db, &steward, &worker, "Step 1", "turn-1", None);
    for step in 2..=task_relay_max() {
        previous = propose(
            &db,
            &steward,
            &worker,
            &format!("Step {step}"),
            "turn-1",
            Some(&previous.id),
        );
    }
    let message = propose_fails(&db, &steward, &worker, "Step 6", "turn-1", &previous.id);
    assert!(
        message.contains("at most 5"),
        "the refusal does not name the limit: {message}"
    );
}

fn task_relay_max() -> usize {
    drafts::MAX_RELAY_CHAIN
}

/// **A revise cannot close a loop**, and the refusal says so rather than walking
/// the chain forever.
#[test]
fn a_revise_cannot_close_a_loop() {
    let (_dir, db, _project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Step 1", "turn-1", None);
    let second = propose(&db, &steward, &worker, "Step 2", "turn-1", Some(&first.id));
    let error = drafts::revise(
        &db,
        &json!({
            "draftId": first.id,
            "card": card("Step 1"),
            "after": second.id,
        }),
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("loops back"),
        "the refusal does not name the loop: {error}"
    );
}

/// **Confirming the second card waits for the first.** The card that follows a
/// card nobody started has no branch to continue, so the click is refused with
/// the instruction that names what to do.
#[test]
fn a_card_cannot_be_confirmed_before_the_card_it_follows() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Step 1", "turn-1", None);
    let second = propose(&db, &steward, &worker, "Step 2", "turn-1", Some(&first.id));
    let error = drafts::confirm(
        &db,
        drafts::ConfirmRequest {
            draft_id: &second.id,
            card_hash: &second.card_hash,
            confirmed_by: drafts::CONFIRMED_BY_USER,
            host_id: Some("mac-mini"),
            device_id: None,
            policy_version: "steward-1",
            notify_on_completion: false,
            idempotency_key: "confirm-second-first",
            project_path: Some(&project),
        },
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("start that card first"),
        "the refusal does not tell the person what to do: {error}"
    );
    // Nothing was created: the refusal is not a half-confirmed card.
    let listed = tasks::list(&db, &json!({})).unwrap();
    assert!(
        listed["tasks"].as_array().unwrap().is_empty(),
        "a task was created for a card whose predecessor was never started"
    );
}

/// **The handoff is one transaction, and repeating it changes nothing.** The
/// second click keeps the first timestamp and answers with the same delivery, so
/// a retried click cannot start the next step twice.
#[test]
fn a_handoff_is_idempotent() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Step 1", "turn-1", None);
    let second = propose(&db, &steward, &worker, "Step 2", "turn-1", Some(&first.id));
    let step_one = confirm(&db, &first, "confirm-1", &project);
    let step_two = confirm(&db, &second, "confirm-2", &project);
    assert_eq!(step_two.relay_state.as_deref(), Some("waiting"));
    assert_eq!(
        step_two.relay_parent_task_id.as_deref(),
        Some(step_one.id.as_str())
    );

    // The step is finished, which is what the completion card shows.
    let st = db.conn();
    st.execute(
        "UPDATE tasks SET stage='person/accept' WHERE id=?1",
        rusqlite::params![step_one.id],
    )
    .unwrap();

    let once = task_relay::handoff(&db, &json!({ "taskId": step_one.id })).unwrap();
    let twice = task_relay::handoff(&db, &json!({ "taskId": step_one.id })).unwrap();
    assert_eq!(once["handedOffAt"], twice["handedOffAt"]);
    assert_eq!(once["unlocked"], twice["unlocked"]);
    assert_eq!(once["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(
        reread(&db, &step_two.id).relay_state.as_deref(),
        Some("ready")
    );
    assert!(reread(&db, &step_one.id).accepted_at.is_some());
}

/// **A waiting step is not work waiting to be started.** Until the handoff, the
/// delivery of the step behind is queued but must not be drained — otherwise the
/// second step runs before the first one.
#[test]
fn a_waiting_step_is_not_drained_and_survives_a_restart() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Step 1", "turn-1", None);
    let second = propose(&db, &steward, &worker, "Step 2", "turn-1", Some(&first.id));
    confirm(&db, &first, "confirm-1", &project);
    let step_two = confirm(&db, &second, "confirm-2", &project);

    let pending = crate::session_collaboration::repository::pending_dispatch(&db).unwrap();
    assert!(
        pending
            .iter()
            .all(|message| message.target_session_id != step_two.session_id),
        "a step that is waiting for its predecessor was drained"
    );

    // A restart fences every queued delivery without a turn as `interrupted`.
    // This one was never started, so it must survive as `queued`.
    crate::session_collaboration::recover(&db).unwrap();
    let status: String = db
        .conn()
        .query_row(
            "SELECT status FROM session_collaboration_messages WHERE id=?1",
            rusqlite::params![step_two.delivery_id.clone().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "queued", "the restart fenced a waiting step");
}

/// **An abandoned step strands the one behind it**, and the card is stuck with
/// the reason on it — not waiting for a step that will never finish.
#[test]
fn abandoning_a_step_orphans_the_next_one_and_starting_from_main_recovers() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Step 1", "turn-1", None);
    let second = propose(&db, &steward, &worker, "Step 2", "turn-1", Some(&first.id));
    let step_one = confirm(&db, &first, "confirm-1", &project);
    let step_two = confirm(&db, &second, "confirm-2", &project);

    tasks::archive(&db, &json!({ "taskId": step_one.id })).unwrap();

    let orphaned = reread(&db, &step_two.id);
    assert_eq!(orphaned.relay_state.as_deref(), Some("orphaned"));
    assert_eq!(orphaned.stage, "blocked");
    let blocker = orphaned.blocker.clone().unwrap();
    assert_eq!(blocker["reason"], json!("relay-orphaned"));
    assert_eq!(blocker["parent"], json!(step_one.short_id));

    // 「改从 main 开工」: the edge goes away, the blocker goes away, and the queued
    // delivery is dispatchable again — the person's own decision, not a fallback.
    let recovered = task_relay::detach(&db, &json!({ "taskId": step_two.id })).unwrap();
    assert_eq!(recovered["task"]["relayState"], Value::Null);
    assert_eq!(recovered["deliveries"].as_array().unwrap().len(), 1);
    let detached = reread(&db, &step_two.id);
    assert!(detached.relay_parent_task_id.is_none());
    assert_eq!(detached.stage, "queued");
    assert!(detached.blocker.is_none());
    let pending = crate::session_collaboration::repository::pending_dispatch(&db).unwrap();
    assert!(
        pending
            .iter()
            .any(|message| message.target_session_id == detached.session_id),
        "the recovered step was not dispatchable again"
    );
}

/// The chain is read from the links, so the card can say "step 2 of 3" without a
/// second table to keep in step.
#[test]
fn the_chain_and_its_positions_are_read_from_the_links() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Step 1", "turn-1", None);
    let second = propose(&db, &steward, &worker, "Step 2", "turn-1", Some(&first.id));
    let third = propose(&db, &steward, &worker, "Step 3", "turn-1", Some(&second.id));
    let step_one = confirm(&db, &first, "confirm-1", &project);
    let step_two = confirm(&db, &second, "confirm-2", &project);
    let step_three = confirm(&db, &third, "confirm-3", &project);

    let chain = tasks::relay_chain(&db, &step_two.id).unwrap();
    assert_eq!(
        chain.iter().map(|task| task.id.clone()).collect::<Vec<_>>(),
        vec![
            step_one.id.clone(),
            step_two.id.clone(),
            step_three.id.clone()
        ]
    );
    assert_eq!(chain[1].relay_step, 2);
    assert_eq!(chain[1].relay_total, 3);
    assert!(tasks::relay_has_successor(&db, &step_two.id).unwrap());
    assert!(!tasks::relay_has_successor(&db, &step_three.id).unwrap());
}

/// **A chain is a line: a card is followed by at most one card.**
///
/// Two cards that both name the same card would fork it, and then nothing
/// downstream can answer "which step is last" — so the second one is refused
/// where it is proposed, naming the rule rather than the fork it leaves behind.
#[test]
fn a_card_cannot_be_the_next_step_of_two_cards() {
    let (_dir, db, _project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Add the column", "turn-1", None);
    propose(
        &db,
        &steward,
        &worker,
        "Backfill it",
        "turn-1",
        Some(&first.id),
    );
    let message = propose_fails(
        &db,
        &steward,
        &worker,
        "Switch the reader",
        "turn-1",
        &first.id,
    );
    assert!(
        message.contains("a step can have only one next step"),
        "the refusal does not name the rule: {message}"
    );
}

/// The same rule on the revise path: a card cannot be moved onto a place that is
/// already taken, even though it was legal where it stood.
#[test]
fn a_revise_cannot_move_a_card_onto_a_taken_place() {
    let (_dir, db, _project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Add the column", "turn-1", None);
    propose(
        &db,
        &steward,
        &worker,
        "Backfill it",
        "turn-1",
        Some(&first.id),
    );
    let free = propose(&db, &steward, &worker, "Switch the reader", "turn-1", None);
    let error = drafts::revise(
        &db,
        &json!({
            "sessionId": steward,
            "draftId": free.id,
            "card": card("Switch the reader"),
            "after": first.id,
        }),
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("a step can have only one next step"),
        "the revise was allowed to fork the chain: {error}"
    );
}

/// **Two clicks cannot both take the one place.**
///
/// Two drafts proposed before either is confirmed are both legal, so the entry
/// check cannot see the fork they would make at the moment of the click: the
/// confirmation is where the second one finds the step in front of it already
/// followed, and it refuses there.
#[test]
fn a_second_confirmation_cannot_fork_the_chain() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Add the column", "turn-1", None);
    let second = propose(
        &db,
        &steward,
        &worker,
        "Backfill it",
        "turn-1",
        Some(&first.id),
    );
    confirm(&db, &first, "confirm-1", &project);
    confirm(&db, &second, "confirm-2", &project);
    // The draft a concurrent click would have confirmed: legal when it was
    // proposed, and a fork by the time it is clicked.
    db.conn()
        .execute(
            "INSERT INTO task_card_drafts
               (id, session_id, status, card_json, card_hash, source_utterance,
                target_session_id, batch_id, after_draft_id, created_at, updated_at)
             SELECT 'forged-sibling', session_id, 'proposed', card_json, card_hash,
                    source_utterance, target_session_id, batch_id, after_draft_id,
                    created_at, updated_at
               FROM task_card_drafts WHERE id=?1",
            rusqlite::params![second.id],
        )
        .unwrap();
    let forged = drafts::get(&db, "forged-sibling").unwrap().unwrap();
    let error = drafts::confirm(
        &db,
        drafts::ConfirmRequest {
            draft_id: &forged.id,
            card_hash: &forged.card_hash,
            confirmed_by: drafts::CONFIRMED_BY_USER,
            host_id: Some("mac-mini"),
            device_id: None,
            policy_version: "steward-1",
            notify_on_completion: false,
            idempotency_key: "confirm-forged",
            project_path: Some(&project),
        },
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("a step can have only one next step"),
        "a second confirmation forked the chain: {error}"
    );
}

/// **A fork that is already in the database is refused, not guessed at.**
///
/// The entry points now keep it from being written, but a row can arrive another
/// way — a repair, a hand-written link. Both readers that decide anything about
/// a chain answer "no" instead of picking one branch.
#[test]
fn a_forked_chain_has_no_answer_for_the_readers() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Add the column", "turn-1", None);
    let second = propose(
        &db,
        &steward,
        &worker,
        "Backfill it",
        "turn-1",
        Some(&first.id),
    );
    let step_one = confirm(&db, &first, "confirm-1", &project);
    let step_two = confirm(&db, &second, "confirm-2", &project);
    // The fork the entry checks would refuse: a second step behind step one.
    let created = tasks::create(
        &db,
        &json!({
            "employeeSessionId": worker,
            "title": "Another step",
            "origin": "direct",
            "projectPath": project,
        }),
    )
    .unwrap();
    let other = created["task"]["id"].as_str().unwrap().to_string();
    db.conn()
        .execute(
            "UPDATE tasks SET relay_parent_task_id=?2, relay_state='waiting' WHERE id=?1",
            rusqlite::params![other, step_one.id],
        )
        .unwrap();

    assert_eq!(
        tasks::relay_fault(&db, &step_two.id).unwrap(),
        Some(tasks::RelayFault::Fork(tasks::short_id(&step_one.id))),
        "the fork was not found from the second step"
    );
    let error = tasks::relay_chain(&db, &step_two.id)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("forks"),
        "the chain was read as if it had one last step: {error}"
    );
    let error = task_relay::handoff(&db, &json!({ "taskId": step_one.id }))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("forks"),
        "the handoff picked one of the two steps: {error}"
    );
}

/// **A chain the host cannot walk is refused, not cut short.**
///
/// Two steps that link to each other are a cycle: no head, no last step, and no
/// honest list to hand the merge. The walk limit is where that shows up, and
/// reaching it has to mean "cannot tell" — a truncated chain is exactly the list
/// the cleanup must not act on.
#[test]
fn a_chain_that_cannot_be_walked_is_refused() {
    let (_dir, db, project) = database();
    let steward = session(&db, "Super Agent", None, "auto");
    let worker = session(&db, "后端", Some("bot"), "accept-edits");
    let first = propose(&db, &steward, &worker, "Add the column", "turn-1", None);
    let second = propose(
        &db,
        &steward,
        &worker,
        "Backfill it",
        "turn-1",
        Some(&first.id),
    );
    let step_one = confirm(&db, &first, "confirm-1", &project);
    let step_two = confirm(&db, &second, "confirm-2", &project);
    // A -> B -> A. Nothing the entry points can write, and exactly what a repair
    // or a hand-written link can leave behind.
    db.conn()
        .execute(
            "UPDATE tasks SET relay_parent_task_id=?2 WHERE id=?1",
            rusqlite::params![step_one.id, step_two.id],
        )
        .unwrap();

    assert_eq!(
        tasks::relay_fault(&db, &step_two.id).unwrap(),
        Some(tasks::RelayFault::Unreadable),
        "a cycle was read as a chain that ends"
    );
    let error = tasks::relay_chain(&db, &step_two.id)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("cannot be read"),
        "the chain was truncated and used: {error}"
    );
    let error = task_relay::handoff(&db, &json!({ "taskId": step_two.id }))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("cannot be read"),
        "the handoff walked a cycle and chose a step: {error}"
    );
}
// ---- the workspace a relay step starts in -----------------------------------

/// The repository a relay test works in: one base commit, a data directory, and
/// the project registered so `prepare` can find it.
struct Repo {
    _dir: tempfile::TempDir,
    state: crate::session_worktrees::lifecycle::SharedState,
    git: crate::session_worktrees::git::GitRunner,
    project: std::path::PathBuf,
}

fn repo() -> Repo {
    use crate::session_worktrees::test_support::{git_cmd, init_repo};
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    std::fs::write(project.join("base.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "base.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "chore: base"]);
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let mut app = crate::state::AppState::open(&data).unwrap();
    app.handshook = true;
    let state: crate::session_worktrees::lifecycle::SharedState =
        std::sync::Arc::new(tokio::sync::Mutex::new(app));
    {
        let db = &state.try_lock().unwrap().db;
        crate::db::upsert_project_row(db.conn(), &project.to_string_lossy(), false).unwrap();
    }
    Repo {
        _dir: dir,
        state,
        git: crate::session_worktrees::git::GitRunner::default(),
        project,
    }
}

async fn task_in(repo: &Repo, title: &str) -> tasks::Task {
    let employee = {
        let st = repo.state.lock().await;
        sessions::create_session_with_options(
            &st.db,
            sessions::SessionCreateOptions {
                title: Some(title.into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                role: Some("bot".into()),
                bot_profile_json: Some(
                    json!({"name": title, "permissionMode": "accept-edits", "observe": false})
                        .to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    };
    let created = {
        let st = repo.state.lock().await;
        tasks::create(
            &st.db,
            &json!({
                "employeeSessionId": employee,
                "title": title,
                "origin": "direct",
                "projectPath": repo.project.to_string_lossy(),
            }),
        )
        .unwrap()
    };
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    crate::tasks::get_task(&repo.state.lock().await.db, &task_id)
        .unwrap()
        .unwrap()
}

fn git_out(dir: &std::path::Path, args: &[&str]) -> String {
    crate::session_worktrees::test_support::git_cmd(dir, args)
}

/// **The next step starts where the previous one stopped.**
///
/// A branch cannot be checked out in two worktrees, so the second step gets its
/// own branch — started from the *end* of the first one's. This is the property
/// the whole feature rests on, so it is proven with real commits.
#[tokio::test]
async fn a_relay_step_starts_from_the_end_of_the_previous_branch() {
    let repo = repo();
    let first = task_in(&repo, "Step one").await;
    crate::task_workspace::prepare(&repo.state, &repo.git, &first.id)
        .await
        .unwrap();
    let first = crate::tasks::get_task(&repo.state.lock().await.db, &first.id)
        .unwrap()
        .unwrap();
    let first_workspace = first.workspace_branch.clone().unwrap();
    let first_path = std::path::PathBuf::from(first.project_path.clone().unwrap());
    let worktree = crate::tasks::get_task(&repo.state.lock().await.db, &first.id)
        .unwrap()
        .unwrap();
    assert!(
        worktree.workspace_status == "ready",
        "step one did not prepare"
    );
    let row = {
        let st = repo.state.lock().await;
        crate::session_worktrees::registry::for_session(&st.db, &first.session_id)
            .unwrap()
            .into_iter()
            .find(|row| row.delegation_id.is_none())
            .unwrap()
    };
    std::fs::write(
        std::path::Path::new(&row.path).join("step-one.txt"),
        "one\n",
    )
    .unwrap();
    git_out(std::path::Path::new(&row.path), &["add", "step-one.txt"]);
    git_out(
        std::path::Path::new(&row.path),
        &["commit", "-q", "-m", "feat: step one"],
    );
    let first_tip = git_out(std::path::Path::new(&row.path), &["rev-parse", "HEAD"]);
    let _ = first_path;

    let second = task_in(&repo, "Step two").await;
    {
        let st = repo.state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE tasks SET relay_parent_task_id=?2, relay_state='ready' WHERE id=?1",
                rusqlite::params![second.id, first.id],
            )
            .unwrap();
    }
    crate::task_workspace::prepare(&repo.state, &repo.git, &second.id)
        .await
        .unwrap();
    let second = crate::tasks::get_task(&repo.state.lock().await.db, &second.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        second.workspace_status, "ready",
        "{:?}",
        second.workspace_error
    );
    assert_eq!(
        second.base_ref.as_deref(),
        Some(format!("refs/heads/{first_workspace}").as_str()),
        "the second step did not record the branch it continues"
    );
    assert!(
        !second.base_remote,
        "a continued branch is local, not fetched"
    );
    let second_row = {
        let st = repo.state.lock().await;
        crate::session_worktrees::registry::for_session(&st.db, &second.session_id)
            .unwrap()
            .into_iter()
            .find(|row| row.delegation_id.is_none())
            .unwrap()
    };
    let head = git_out(
        std::path::Path::new(&second_row.path),
        &["rev-parse", "HEAD"],
    );
    assert_eq!(
        head.trim(),
        first_tip.trim(),
        "the second step did not start where the first one stopped"
    );
    assert!(
        std::path::Path::new(&second_row.path)
            .join("step-one.txt")
            .is_file(),
        "the first step's commit is not in the second step's workspace"
    );
}

/// **A missing predecessor branch stops the step.** Falling back to `main`
/// would deliver a change from a base nobody chose, so the step is blocked with
/// the reason on its card instead.
#[tokio::test]
async fn a_step_whose_predecessor_branch_is_gone_is_blocked_not_restarted_from_main() {
    let repo = repo();
    let first = task_in(&repo, "Step one").await;
    crate::task_workspace::prepare(&repo.state, &repo.git, &first.id)
        .await
        .unwrap();
    let first = crate::tasks::get_task(&repo.state.lock().await.db, &first.id)
        .unwrap()
        .unwrap();
    let branch = first.workspace_branch.clone().unwrap();

    let second = task_in(&repo, "Step two").await;
    {
        let st = repo.state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE tasks SET relay_parent_task_id=?2, relay_state='ready' WHERE id=?1",
                rusqlite::params![second.id, first.id],
            )
            .unwrap();
    }
    // The predecessor's branch is cleaned up before the next step starts: an
    // ordinary accident (a merged step, an archived one).
    let row = {
        let st = repo.state.lock().await;
        crate::session_worktrees::registry::for_session(&st.db, &first.session_id)
            .unwrap()
            .into_iter()
            .find(|row| row.delegation_id.is_none())
            .unwrap()
    };
    git_out(&repo.project, &["worktree", "unlock", &row.path]);
    git_out(&repo.project, &["worktree", "remove", "--force", &row.path]);
    git_out(&repo.project, &["worktree", "prune"]);
    git_out(&repo.project, &["branch", "-D", &branch]);

    crate::task_workspace::prepare(&repo.state, &repo.git, &second.id)
        .await
        .unwrap();
    let second = crate::tasks::get_task(&repo.state.lock().await.db, &second.id)
        .unwrap()
        .unwrap();
    assert_eq!(second.workspace_status, "failed");
    assert_eq!(second.stage, "blocked");
    let blocker = second.blocker.clone().unwrap();
    assert_eq!(blocker["reason"], json!("relay-base"));
    assert!(
        second.workspace_error.unwrap_or_default().contains("gone"),
        "the failure does not say what happened"
    );
    assert!(
        second.workspace_branch.is_none(),
        "a step was created from main after its predecessor's branch vanished"
    );
}
