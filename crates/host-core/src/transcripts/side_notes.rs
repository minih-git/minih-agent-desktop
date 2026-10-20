//! Independent side-panel question/answer history; never model transcript rows.
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideNote {
    pub id: String,
    pub question: String,
    pub answer: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

pub fn path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    super::path_for(data_dir, session_id, ".side-notes.jsonl")
}

pub fn read(data_dir: &Path, session_id: &str) -> Result<Vec<SideNote>> {
    let path = path(data_dir, session_id)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let mut notes = Vec::new();
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut line = String::new();
    loop {
        let (size, corrupt_utf8) = super::read_line_tolerant(&mut reader, &mut bytes, &mut line)?;
        if size == 0 {
            break;
        }
        if corrupt_utf8 {
            tracing::warn!(path = %path.display(), "ignoring torn UTF-8 side-note record");
            continue;
        }
        match serde_json::from_str(&line) {
            Ok(note) => notes.push(note),
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "ignoring incomplete side-note record")
            }
        }
    }
    Ok(notes)
}

pub fn append(data_dir: &Path, session_id: &str, note: &SideNote) -> Result<()> {
    if uuid::Uuid::parse_str(&note.id).is_err()
        || note.question.trim().is_empty()
        || note.question.len() > 131_072
        || note.answer.trim().is_empty()
        || note.answer.len() > 1_048_576
        || chrono::DateTime::parse_from_rfc3339(&note.created_at).is_err()
    {
        return Err(anyhow!("invalid side-note record"));
    }
    super::append_line(
        &path(data_dir, session_id)?,
        None,
        serde_json::to_string(note)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::Database, sessions};
    use std::io::Write;

    fn note(question: &str) -> SideNote {
        SideNote {
            id: uuid::Uuid::new_v4().to_string(),
            question: question.into(),
            answer: "A side answer".into(),
            created_at: "2026-10-20T00:00:00Z".into(),
            usage: None,
        }
    }

    #[test]
    fn separate_history_roundtrips_without_touching_main_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session =
            sessions::create_session(&db, Some("side notes".into()), None, None, None, None)
                .unwrap();
        assert!(read(db.data_dir(), &session.id).unwrap().is_empty());
        let before = sessions::get_session(&db, &session.id).unwrap().unwrap();
        let expected = note("How far along?");
        append(db.data_dir(), &session.id, &expected).unwrap();
        assert_eq!(read(db.data_dir(), &session.id).unwrap()[0].id, expected.id);
        let after = sessions::get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(before.messages.len(), after.messages.len());
        assert_eq!(before.summary.updated_at, after.summary.updated_at);
        assert_eq!(before.summary.message_count, after.summary.message_count);
        let file = path(db.data_dir(), &session.id).unwrap();
        assert!(file.exists());
        sessions::delete_session(&db, &session.id).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn torn_append_does_not_hide_the_next_completed_answer() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), "session", &note("First")).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path(dir.path(), "session").unwrap())
            .unwrap();
        file.write_all(br#"{"id":"torn""#).unwrap();
        append(dir.path(), "session", &note("Second")).unwrap();
        let notes = read(dir.path(), "session").unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[1].question, "Second");
        assert!(read(dir.path(), "../escape").is_err());
        assert!(append(dir.path(), "../escape", &note("No")).is_err());
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path(dir.path(), "session").unwrap())
            .unwrap();
        file.write_all(&[0xf0, 0x9f]).unwrap();
        assert_eq!(read(dir.path(), "session").unwrap().len(), 2);
        append(dir.path(), "session", &note("After torn UTF-8")).unwrap();
        assert_eq!(read(dir.path(), "session").unwrap().len(), 3);
    }
}
