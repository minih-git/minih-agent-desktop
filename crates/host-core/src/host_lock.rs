//! One host process per data directory.
//!
//! The host is the single writer of `pi.sqlite` (D002), and its boot maintenance
//! settles every `running` turn, `task_runs` row, and pending Plan approval it
//! finds (see `db::migrations::boot_maintenance`). That is correct exactly when
//! nothing else is using the directory: it is how a crash is cleaned up on the
//! next boot. It is destructive when another host is running there — a stray
//! manual invocation used to reach it and mark the live host's turns `aborted`.
//!
//! The lock below is taken before `AppState::open`, so a second process never
//! gets as far as the maintenance. It is an OS file lock on an open handle, not
//! a marker file: the kernel drops it when the process exits, so a crash cannot
//! leave a stale lock behind, and the file itself is never deleted.

use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Lock file inside the data directory. It carries no content.
pub const LOCK_FILE_NAME: &str = "host.lock";

/// Exit code for a data directory another host process still owns.
pub const EXIT_DATA_DIR_BUSY: i32 = 3;

/// How long a start waits for a previous host to release the directory.
///
/// Electron main disposes the old child before it asks the supervisor for a
/// restart (3 s graceful, then a 1 s force kill), so a real handover is over in
/// a few seconds; the wait covers that race without turning a second, genuinely
/// concurrent host into a slow start. Anything still holding the lock after it
/// is a different owner: another installation, or a process the user started.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const ACQUIRE_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// Held for the lifetime of the process; the lock is released when it drops.
#[derive(Debug)]
pub struct DataDirLock {
    path: PathBuf,
    // Never read: the open handle *is* the lock.
    _file: File,
}

impl DataDirLock {
    /// The lock file that keeps this data directory exclusive.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Why a data directory could not be locked.
#[derive(Debug)]
pub enum AcquireError {
    /// Another process held the lock for the whole wait.
    Busy { path: PathBuf, waited: Duration },
    /// The lock file could not be opened or locked (permissions, I/O).
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcquireError::Busy { path, waited } => write!(
                f,
                "another host-core process is using the data directory; {} is locked \
                 (waited {} ms for it to be released)",
                path.display(),
                waited.as_millis()
            ),
            AcquireError::Io { path, source } => {
                write!(f, "cannot lock {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for AcquireError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AcquireError::Busy { .. } => None,
            AcquireError::Io { source, .. } => Some(source),
        }
    }
}

/// Take the data directory's exclusive lock, waiting up to [`ACQUIRE_TIMEOUT`]
/// for a previous host to finish releasing it.
///
/// The directory must exist; the caller creates it first because the lock file
/// lives inside it.
pub fn acquire(data_dir: &Path) -> Result<DataDirLock, AcquireError> {
    acquire_within(data_dir, ACQUIRE_TIMEOUT)
}

fn acquire_within(data_dir: &Path, timeout: Duration) -> Result<DataDirLock, AcquireError> {
    let path = data_dir.join(LOCK_FILE_NAME);
    // Read+write because Windows' LockFileEx needs a handle with access rights
    // to it; `create(true)` keeps one lock file across restarts.
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|source| AcquireError::Io {
            path: path.clone(),
            source,
        })?;

    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(DataDirLock { path, _file: file }),
            Err(TryLockError::WouldBlock) => {
                let waited = started.elapsed();
                if waited >= timeout {
                    return Err(AcquireError::Busy { path, waited });
                }
                std::thread::sleep(ACQUIRE_RETRY_INTERVAL);
            }
            Err(TryLockError::Error(source)) => return Err(AcquireError::Io { path, source }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_acquire_is_refused_until_the_first_drops() {
        let dir = tempfile::tempdir().expect("temp dir");
        let first = acquire(dir.path()).expect("first lock");

        match acquire_within(dir.path(), Duration::from_millis(250)) {
            Err(AcquireError::Busy { path, .. }) => {
                assert_eq!(path, dir.path().join(LOCK_FILE_NAME));
            }
            other => panic!("expected Busy, got {other:?}"),
        }

        // Released when the handle drops, and the same file is reused: no stale
        // lock can outlive the process that took it.
        drop(first);
        let again = acquire_within(dir.path(), Duration::from_millis(250)).expect("second lock");
        assert_eq!(again.path(), dir.path().join(LOCK_FILE_NAME));
    }

    #[test]
    fn the_lock_file_is_not_a_marker() {
        let dir = tempfile::tempdir().expect("temp dir");
        {
            let _lock = acquire(dir.path()).expect("lock");
        }
        let lock_path = dir.path().join(LOCK_FILE_NAME);
        assert!(lock_path.exists(), "the lock file stays on disk");
        assert_eq!(
            std::fs::read(&lock_path).expect("read lock file").len(),
            0,
            "the lock carries no content, so a leftover file says nothing"
        );
    }
}
