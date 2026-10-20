//! Trusted Desktop IPC storage for isolated side-note answers.
use super::{rpc_err, AppState, JsonRpcError};
use crate::{sessions, transcripts::side_notes};
use serde_json::{json, Value};

pub fn handle(state: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_ARGUMENT"))?;
    if sessions::session_summary(&state.db, session_id)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .is_none()
    {
        return Err(rpc_err(1007, "session not found", "NOT_FOUND"));
    }
    match method {
        "session.sideNotes.list" => Ok(
            json!({ "notes": side_notes::read(state.db.data_dir(), session_id)
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))? }),
        ),
        "session.sideNotes.append" => {
            let note: side_notes::SideNote =
                serde_json::from_value(params.get("note").cloned().unwrap_or(Value::Null))
                    .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_ARGUMENT"))?;
            side_notes::append(state.db.data_dir(), session_id, &note)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            Ok(json!({ "note": note }))
        }
        _ => Err(rpc_err(
            -32601,
            "unknown side-note method",
            "METHOD_NOT_FOUND",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_rpc_roundtrips_and_refuses_deleted_session() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(dir.path()).unwrap();
        let session =
            sessions::create_session(&state.db, Some("side notes".into()), None, None, None, None)
                .unwrap();
        let note = json!({ "id": uuid::Uuid::new_v4().to_string(), "question": "Progress?", "answer": "Halfway", "createdAt": "2026-10-20T00:00:00Z" });
        let input = json!({ "sessionId": session.id, "note": note });
        assert_eq!(
            handle(&state, "session.sideNotes.append", input.clone()).unwrap()["note"],
            note
        );
        assert_eq!(
            handle(&state, "session.sideNotes.list", input.clone()).unwrap()["notes"],
            json!([note])
        );
        let path = side_notes::path(state.db.data_dir(), &session.id).unwrap();
        sessions::delete_session(&state.db, &session.id).unwrap();
        assert!(handle(&state, "session.sideNotes.append", input).is_err());
        assert!(!path.exists());
        assert!(handle(
            &state,
            "session.sideNotes.list",
            json!({ "sessionId": "../escape" })
        )
        .is_err());
    }
}
