//! Reading a pull request, and the table that decides whether it may merge.
//!
//! A fact that cannot be read is a refusal, never a pass: a green button over an
//! unknown state is worse than a grey one that says why. The table itself is a
//! pure function, so every row of it has a test that needs no network, no login
//! and no repository.

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;

// ---- reading a pull request -------------------------------------------------

/// One check on a PR, as `gh` reports it.
///
/// Two shapes share the array: a GitHub **CheckRun** (`name`/`status`/
/// `conclusion`) and a legacy **StatusContext** (`context`/`state`). Both are
/// read, because a repository that still reports one status per job would
/// otherwise look like it had no CI at all.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

impl CheckRun {
    fn label(&self) -> String {
        self.name
            .clone()
            .or_else(|| self.context.clone())
            .unwrap_or_default()
    }

    /// `passed`, `pending`, or `failed`.
    fn outcome(&self) -> &'static str {
        if let Some(conclusion) = self.conclusion.as_deref().filter(|v| !v.is_empty()) {
            return match conclusion {
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => "passed",
                _ => "failed",
            };
        }
        if let Some(state) = self.state.as_deref().filter(|v| !v.is_empty()) {
            return match state {
                "SUCCESS" => "passed",
                "PENDING" | "EXPECTED" => "pending",
                _ => "failed",
            };
        }
        // A CheckRun that has not concluded yet: `status` is QUEUED, IN_PROGRESS,
        // or COMPLETED with no conclusion (which only happens on a re-run).
        match self.status.as_deref() {
            Some("COMPLETED") => "failed",
            _ => "pending",
        }
    }
}

/// The facts the gate is decided from, as `gh pr list --json` returns them.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFacts {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub mergeable: Option<String>,
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub head_ref_oid: Option<String>,
    #[serde(default)]
    pub status_check_rollup: Option<Vec<CheckRun>>,
}

/// What the card shows about CI: how many checks, and which ones failed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    pub total: usize,
    pub passed: usize,
    pub pending: usize,
    pub failed: Vec<String>,
}

impl CheckSummary {
    pub fn of(checks: &[CheckRun]) -> Self {
        let mut summary = CheckSummary::default();
        for check in checks {
            summary.total += 1;
            match check.outcome() {
                "passed" => summary.passed += 1,
                "pending" => summary.pending += 1,
                _ => summary.failed.push(check.label()),
            }
        }
        summary
    }
}

/// The fields asked of `gh`. One constant, so the reader and the tests cannot
/// disagree about what was requested.
pub const PR_FIELDS: &str = "state,mergeable,statusCheckRollup,reviewDecision,headRefOid,url";

/// How the host reads a pull request.
///
/// Injectable because the gate must be provable without a network, a login, or a
/// repository: the tests drive a scripted reader, and nothing in this module
/// ever prints what it returns — the credentials are `gh`'s own.
#[async_trait]
pub trait GhRunner: Send + Sync {
    /// Run `gh` in `dir` and return stdout; a non-zero exit is an error whose
    /// message is safe to show (never a token, never the environment).
    async fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String>;
}

/// The real reader: `gh` from the login PATH, non-interactive, bounded.
pub struct GhCli {
    program: PathBuf,
    path_env: Option<String>,
    timeout: Duration,
}

impl Default for GhCli {
    fn default() -> Self {
        Self {
            program: PathBuf::from("gh"),
            // The same login PATH the git runner and the Bash tool use: a GUI
            // launch has neither `/usr/local/bin` nor the user's shell paths.
            path_env: crate::tools::shell::user_login_path().map(str::to_string),
            timeout: Duration::from_secs(60),
        }
    }
}

#[async_trait]
impl GhRunner for GhCli {
    async fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        let mut command = tokio::process::Command::new(&self.program);
        command.current_dir(dir).args(args);
        command
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = self.path_env.as_deref() {
            command.env("PATH", path);
        }
        let output = match tokio::time::timeout(self.timeout, command.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("gh is not installed".to_string());
            }
            Ok(Err(error)) => return Err(format!("gh could not be started: {error}")),
            Err(_) => return Err("gh did not answer in time".to_string()),
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = stderr.trim().lines().next().unwrap_or("gh failed");
            return Err(message.to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// Read the open PR whose head is `branch`, if there is one.
pub(super) async fn read_pr(
    gh: &dyn GhRunner,
    project: &Path,
    branch: &str,
) -> std::result::Result<Option<PrFacts>, String> {
    let output = gh
        .run(
            project,
            &[
                "pr", "list", "--head", branch, "--state", "open", "--json", PR_FIELDS, "--limit",
                "1",
            ],
        )
        .await?;
    let parsed: Vec<PrFacts> = serde_json::from_str(&output)
        .map_err(|error| format!("gh returned an unreadable answer: {error}"))?;
    Ok(parsed.into_iter().next())
}

/// The state `gh` reports for the branch's PR, whatever it is (`OPEN`,
/// `MERGED`, `CLOSED`), or `None` when there is no PR at all.
pub(super) async fn read_pr_state(
    gh: &dyn GhRunner,
    project: &Path,
    branch: &str,
) -> std::result::Result<Option<String>, String> {
    let output = gh
        .run(
            project,
            &[
                "pr", "list", "--head", branch, "--state", "all", "--json", "state", "--limit", "1",
            ],
        )
        .await?;
    let parsed: Vec<Value> = serde_json::from_str(&output)
        .map_err(|error| format!("gh returned an unreadable answer: {error}"))?;
    Ok(parsed
        .first()
        .and_then(|entry| entry.get("state"))
        .and_then(Value::as_str)
        .map(str::to_owned))
}

// ---- the gate ---------------------------------------------------------------

/// The gate's verdict. `reason` is a stable code the renderer translates; the
/// detail is the one name a person needs (which check failed, which remote).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub can_merge: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_detail: Option<String>,
}

impl Gate {
    pub(super) fn refuse(reason: &str, detail: Option<String>) -> Self {
        Gate {
            can_merge: false,
            reason: Some(reason.to_string()),
            reason_detail: detail,
        }
    }

    pub(super) fn allow() -> Self {
        Gate {
            can_merge: true,
            reason: None,
            reason_detail: None,
        }
    }
}

/// **The table.** Every row of the design, in one pure function, in the order
/// the person reads them: is there a PR, did CI run, did it pass, will it merge,
/// was it reviewed.
///
/// A fact that could not be read is not a row here: it arrives as `Err` from
/// `read_pr` and is refused by [`gate_unreadable`], because "nobody could tell"
/// and "everything is fine" must never render the same button.
pub fn gate_for(facts: Option<&PrFacts>) -> Gate {
    let Some(facts) = facts else {
        return Gate::refuse("pr-missing", None);
    };
    let rollup = facts.status_check_rollup.as_deref().unwrap_or_default();
    if rollup.is_empty() {
        return Gate::refuse("ci-missing", None);
    }
    let checks = CheckSummary::of(rollup);
    if !checks.failed.is_empty() {
        return Gate::refuse("ci-failed", Some(checks.failed.join(", ")));
    }
    if checks.pending > 0 {
        return Gate::refuse("ci-running", Some(checks.pending.to_string()));
    }
    // **Only `MERGEABLE` passes.** An absent value, `UNKNOWN`, and any value
    // GitHub adds later all mean "nobody can say whether this merges", and a
    // merge that turns out to conflict is not something a retry undoes.
    match facts.mergeable.as_deref() {
        Some("MERGEABLE") => {}
        Some("CONFLICTING") => return Gate::refuse("conflict", None),
        other => {
            return Gate::refuse(
                "mergeable-unknown",
                Some(other.unwrap_or("missing").to_string()),
            )
        }
    }
    match facts.review_decision.as_deref().unwrap_or("") {
        "REVIEW_REQUIRED" => return Gate::refuse("review-required", None),
        "CHANGES_REQUESTED" => return Gate::refuse("review-required", None),
        // Empty and APPROVED both mean "nothing is blocking the merge here".
        _ => {}
    }
    Gate::allow()
}

pub fn gate_unreadable(message: &str) -> Gate {
    Gate::refuse("pr-unreadable", Some(message.to_string()))
}
#[cfg(test)]
mod tests {
    use super::*;

    fn check_run(name: &str, status: Option<&str>, conclusion: Option<&str>) -> CheckRun {
        CheckRun {
            name: Some(name.to_string()),
            status: status.map(str::to_owned),
            conclusion: conclusion.map(str::to_owned),
            ..CheckRun::default()
        }
    }

    fn facts(mergeable: &str, review: &str, checks: Vec<CheckRun>) -> PrFacts {
        PrFacts {
            url: Some("https://github.com/o/r/pull/7".to_string()),
            mergeable: Some(mergeable.to_string()),
            review_decision: Some(review.to_string()),
            head_ref_oid: Some("abc123".to_string()),
            status_check_rollup: Some(checks),
        }
    }

    fn green() -> Vec<CheckRun> {
        vec![
            check_run("build", Some("COMPLETED"), Some("SUCCESS")),
            check_run("test", Some("COMPLETED"), Some("SUCCESS")),
        ]
    }

    /// The table, one test per row of the design: every reason the button is
    /// grey has its own case, so a rule cannot be dropped silently.
    #[test]
    fn every_gate_row_refuses_with_its_own_reason() {
        // No PR at all.
        assert_eq!(gate_for(None).reason.as_deref(), Some("pr-missing"));

        // No CI result yet (an empty rollup, and a null one).
        assert_eq!(
            gate_for(Some(&facts("MERGEABLE", "", vec![])))
                .reason
                .as_deref(),
            Some("ci-missing")
        );
        let mut no_rollup = facts("MERGEABLE", "", vec![]);
        no_rollup.status_check_rollup = None;
        assert_eq!(
            gate_for(Some(&no_rollup)).reason.as_deref(),
            Some("ci-missing")
        );

        // A check still running.
        let running = facts(
            "MERGEABLE",
            "",
            vec![
                check_run("build", Some("COMPLETED"), Some("SUCCESS")),
                check_run("e2e", Some("IN_PROGRESS"), None),
            ],
        );
        let gate = gate_for(Some(&running));
        assert_eq!(gate.reason.as_deref(), Some("ci-running"));
        assert!(!gate.can_merge);

        // A failed check names itself.
        let failed = facts(
            "MERGEABLE",
            "",
            vec![
                check_run("build", Some("COMPLETED"), Some("SUCCESS")),
                check_run("e2e", Some("COMPLETED"), Some("FAILURE")),
            ],
        );
        let gate = gate_for(Some(&failed));
        assert_eq!(gate.reason.as_deref(), Some("ci-failed"));
        assert_eq!(gate.reason_detail.as_deref(), Some("e2e"));

        // A legacy commit status is read the same way.
        let legacy = facts(
            "MERGEABLE",
            "",
            vec![CheckRun {
                context: Some("ci/legacy".to_string()),
                state: Some("FAILURE".to_string()),
                ..CheckRun::default()
            }],
        );
        assert_eq!(
            gate_for(Some(&legacy)).reason_detail.as_deref(),
            Some("ci/legacy")
        );

        // A conflict, and GitHub still computing.
        assert_eq!(
            gate_for(Some(&facts("CONFLICTING", "", green())))
                .reason
                .as_deref(),
            Some("conflict")
        );
        assert_eq!(
            gate_for(Some(&facts("UNKNOWN", "", green())))
                .reason
                .as_deref(),
            Some("mergeable-unknown")
        );

        // Review required, and changes requested.
        assert_eq!(
            gate_for(Some(&facts("MERGEABLE", "REVIEW_REQUIRED", green())))
                .reason
                .as_deref(),
            Some("review-required")
        );
        assert_eq!(
            gate_for(Some(&facts("MERGEABLE", "CHANGES_REQUESTED", green())))
                .reason
                .as_deref(),
            Some("review-required")
        );
    }

    /// **Only `MERGEABLE` is a pass.** A value GitHub has not taught us, and a
    /// missing one, are refusals — a merge that turns out to conflict is not
    /// something a retry undoes.
    #[test]
    fn a_mergeable_value_other_than_mergeable_is_refused_with_the_value() {
        for value in [Some("MERGEABLE_DIRTY"), Some("BLOCKED"), None] {
            let mut facts = facts("MERGEABLE", "APPROVED", green());
            facts.mergeable = value.map(str::to_owned);
            let gate = gate_for(Some(&facts));
            assert!(!gate.can_merge, "`{value:?}` passed the gate");
            assert_eq!(gate.reason.as_deref(), Some("mergeable-unknown"));
            assert_eq!(
                gate.reason_detail.as_deref(),
                Some(value.unwrap_or("missing")),
                "the refusal does not carry the value it saw"
            );
        }
    }

    /// The two answers that are *not* refusals: an empty review decision and an
    /// approved one both mean "nothing is blocking the merge here".
    #[test]
    fn an_absent_or_approved_review_passes_the_gate() {
        for review in ["", "APPROVED"] {
            let gate = gate_for(Some(&facts("MERGEABLE", review, green())));
            assert!(gate.can_merge, "review `{review}` must not refuse");
            assert_eq!(gate.reason, None);
        }
    }

    /// A read that failed is a refusal with the reason, never a pass: this is
    /// the row that would otherwise show a green button over an unknown state.
    #[test]
    fn a_read_that_failed_refuses_with_its_reason() {
        let gate = gate_unreadable("gh is not installed");
        assert!(!gate.can_merge);
        assert_eq!(gate.reason.as_deref(), Some("pr-unreadable"));
        assert_eq!(gate.reason_detail.as_deref(), Some("gh is not installed"));
    }

    #[test]
    fn a_check_summary_counts_each_outcome_once() {
        let summary = CheckSummary::of(&[
            check_run("a", Some("COMPLETED"), Some("SUCCESS")),
            check_run("b", Some("QUEUED"), None),
            check_run("c", Some("COMPLETED"), Some("FAILURE")),
            CheckRun {
                context: Some("d".to_string()),
                state: Some("SUCCESS".to_string()),
                ..CheckRun::default()
            },
        ]);
        assert_eq!(summary.total, 4);
        assert_eq!(summary.passed, 2);
        assert_eq!(summary.pending, 1);
        assert_eq!(summary.failed, vec!["c".to_string()]);
    }
}
