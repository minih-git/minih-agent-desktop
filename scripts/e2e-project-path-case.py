"""Exercise the selected native project alias repair through a real Minih Host.

Usage: python3 scripts/e2e-project-path-case.py HOST
Only a scratch profile and synthetic projects are used. No provider is called.
Adapted from PI-Desktop b55628bf4/e89807ba0 for Minih schema v29 -> v30.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import tempfile
import threading


class Host:
    def __init__(self, binary, profile):
        self.process = subprocess.Popen(
            [binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            env=dict(os.environ, MINIH_AGENT_DATA_DIR=str(profile)),
        )
        self.lines = queue.Queue()
        threading.Thread(target=self.read, daemon=True).start()
        self.request_id = 0
        try:
            self.call("app.handshake", protocolVersion=12)
        except BaseException:
            self.close()
            raise

    def read(self):
        for line in self.process.stdout:
            self.lines.put(json.loads(line))
        self.lines.put(None)

    def call(self, method, **params):
        self.request_id += 1
        request_id = self.request_id
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id,
                                            "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        while True:
            message = self.lines.get(timeout=45)
            if message is None:
                self.process.wait(timeout=10)
                raise AssertionError(f"Fixture Host exited: {self.process.returncode}")
            if message.get("id") == request_id:
                assert "error" not in message, message
                return message["result"]

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", type=lambda value: str(Path(value).resolve(strict=True)))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="minih-project-path-", dir=os.environ.get("PI_SCRATCH_DIR")) as temporary:
        root = Path(temporary).resolve()
        folder = root / "Alpha"
        folder.mkdir()
        alias = str(root / "alpha").replace("\\", "/")
        assert (root / "alpha").is_dir(), "This native alias journey requires a case-insensitive filesystem"
        profile = root / "profile"
        host = Host(args.host, profile)
        try:
            first = host.call("session.create", title="Alias conversation", projectPath=str(folder))["session"]["id"]
            second = host.call("session.create", title="Canonical conversation", projectPath=str(folder))["session"]["id"]
            other = root / "Other"
            other.mkdir()
            unrelated = host.call("session.create", title="Unrelated", projectPath=str(other))["session"]["id"]
            for session_id in (first, second, unrelated):
                host.call("session.appendMessage", sessionId=session_id,
                          message={"id": session_id + "-message", "role": "user", "content": "Synthetic fixture", "createdAt": "2026-11-09T00:00:00Z"})
        finally:
            host.close()
        transcripts = {sid: (profile / "sessions" / (sid + ".jsonl")).read_bytes()
                       for sid in (first, second, unrelated)}
        database = profile / "pi.sqlite"
        with closing(sqlite3.connect(database)) as conn:
            canonical_id, canonical = conn.execute("SELECT id,path FROM projects WHERE id=(SELECT project_id FROM sessions WHERE id=?)", (second,)).fetchone()
            assert canonical != alias
            conn.execute("INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?,?,1,1)", (alias, "Alias"))
            alias_id = conn.execute("SELECT id FROM projects WHERE path=?", (alias,)).fetchone()[0]
            conn.execute("UPDATE sessions SET project_id=? WHERE id=?", (alias_id, first))
            conn.execute("INSERT INTO scheduled_tasks(id,title,prompt,project_id,config_json,enabled,created_at,updated_at) VALUES('fixture-task','Task','Synthetic',?,?,1,1,1)", (alias_id, json.dumps({"workspacePath": alias})))
            conn.execute("INSERT INTO keep_warm_usage(id,session_id,status,created_at) VALUES('fixture-warm',?,'skipped',1)", (first,))
            conn.execute("INSERT INTO conversation_summaries(session_id,summary_json,updated_at) VALUES(?,'{}',1)", (first,))
            conn.execute("PRAGMA user_version=29")
            conn.commit()
        host = Host(args.host, profile)
        try:
            projects = host.call("projects.list")["projects"]
            matching = [item for item in projects if item["path"].lower() == canonical.lower()]
            assert len(matching) == 1, "Native aliases survived the upgrade"
            with closing(sqlite3.connect(database)) as conn:
                assert conn.execute("PRAGMA user_version").fetchone()[0] == 30
                owners = dict(conn.execute("SELECT id,project_id FROM sessions WHERE id IN (?,?)", (first, second)))
                assert len(owners) == 2 and len(set(owners.values())) == 1
                assert conn.execute("SELECT project_id FROM scheduled_tasks WHERE id='fixture-task'").fetchone()[0] == owners[first]
                assert conn.execute("SELECT count(*) FROM keep_warm_usage").fetchone()[0] == 1
                assert conn.execute("SELECT count(*) FROM conversation_summaries").fetchone()[0] == 1
            backup = database.with_suffix(".sqlite.v29.bak")
            assert backup.exists(), "Upgrade must preserve a versioned backup"
            with closing(sqlite3.connect(backup)) as conn:
                assert conn.execute("PRAGMA user_version").fetchone()[0] == 29
                before = dict(conn.execute("SELECT id,project_id FROM sessions WHERE id IN (?,?)", (first, second)))
                assert len(before) == 2 and len(set(before.values())) == 2
            for sid in (first, second, unrelated):
                assert (profile / "sessions" / (sid + ".jsonl")).read_bytes() == transcripts[sid]
            result = host.call("projects.remove", path=alias)
            assert result == {"removed": True, "sessionsRemoved": 2}, result
            with closing(sqlite3.connect(database)) as conn:
                remaining = dict(conn.execute("SELECT id,project_id FROM sessions"))
                assert unrelated in remaining and first not in remaining and second not in remaining
                assert not any(path.lower() == canonical.lower() for (path,) in conn.execute("SELECT path FROM projects"))
                assert conn.execute("SELECT enabled FROM scheduled_tasks WHERE id='fixture-task'").fetchone()[0] == 0
            assert (profile / "sessions" / (unrelated + ".jsonl")).read_bytes() == transcripts[unrelated]
            assert folder.is_dir(), "Removing a project must not delete the physical folder"
            assert all(not (profile / "sessions" / (sid + ".jsonl")).exists() for sid in (first, second))
            print("PASS: v29 backup, v30 native alias repair, session/task/custom data preservation, and scoped project deletion")
        finally:
            host.close()


if __name__ == "__main__":
    main()
