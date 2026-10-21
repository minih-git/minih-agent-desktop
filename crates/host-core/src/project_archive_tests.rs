use super::*;
use crate::state::AppState;

fn silent(_phase: &'static str, _done: u64, _total: u64) {}

fn write_file(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent");
    }
    fs::write(path, content).expect("write file");
}

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = File::create(path).expect("zip file");
    let mut writer = ZipWriter::new(BufWriter::new(file));
    for (name, bytes) in entries {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .expect("zip entry");
        writer.write_all(bytes).expect("zip bytes");
    }
    writer.finish().expect("zip finish");
}

fn manifest_bytes(manifest: &ArchiveManifest) -> Vec<u8> {
    serde_json::to_vec_pretty(manifest).expect("manifest")
}

fn one_root_manifest(name: &str) -> ArchiveManifest {
    ArchiveManifest {
        format: ARCHIVE_FORMAT.into(),
        version: ARCHIVE_VERSION,
        created_at: "2026-01-01T00:00:00Z".into(),
        name: name.into(),
        roots: vec![ArchiveRoot {
            index: 0,
            name: name.into(),
            file_count: 0,
            total_bytes: 0,
            skipped_symlinks: 0,
            skipped_secret_files: 0,
        }],
        group: None,
        projects: Vec::new(),
    }
}

fn read_archive_manifest(path: &Path) -> ArchiveManifest {
    let file = File::open(path).expect("archive file");
    let mut archive = ZipArchive::new(BufReader::new(file)).expect("archive");
    let mut entry = archive.by_name(MANIFEST_ENTRY).expect("manifest entry");
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).expect("manifest bytes");
    serde_json::from_slice(&bytes).expect("manifest")
}

/// Copy an archive with a different manifest, so a test can play a hand-edited
/// or hostile archive that still has valid entries.
fn rewrite_manifest(archive: &Path, manifest: &ArchiveManifest, target: &Path) {
    let source = File::open(archive).expect("archive");
    let mut reader = ZipArchive::new(BufReader::new(source)).expect("zip");
    let file = File::create(target).expect("target");
    let mut writer = ZipWriter::new(BufWriter::new(file));
    writer
        .start_file(MANIFEST_ENTRY, SimpleFileOptions::default())
        .expect("manifest entry");
    writer
        .write_all(&manifest_bytes(manifest))
        .expect("manifest bytes");
    for index in 0..reader.len() {
        let mut entry = reader.by_index(index).expect("entry");
        let name = entry.name().to_string();
        if name == MANIFEST_ENTRY {
            continue;
        }
        writer
            .start_file(name, SimpleFileOptions::default())
            .expect("copy entry");
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).expect("read entry");
        writer.write_all(&bytes).expect("write entry");
    }
    writer.finish().expect("finish");
}

fn export(state: &mut AppState, project: &Path, target: &Path) -> Value {
    let plan = export_plan(
        state,
        &json!({
            "projectPath": project.to_string_lossy(),
            "targetPath": target.to_string_lossy(),
        }),
        &silent,
    )
    .expect("export plan");
    export_write(&plan, &silent).expect("export write")
}

fn import(data_dir: &Path, archive: &Path, target_parent: &Path) -> Result<Value> {
    let staged = stage_import(
        data_dir,
        &json!({
            "archivePath": archive.to_string_lossy(),
            "targetParentPath": target_parent.to_string_lossy(),
        }),
        &silent,
    )?;
    let mut state = AppState::open(data_dir)?;
    apply_import(&mut state, &staged, &silent)
}

fn canonical(path: &Path) -> String {
    fs::canonicalize(path)
        .expect("canonical path")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn exports_and_imports_a_project_with_its_managed_configuration() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("widget");
    fs::create_dir_all(project.join(".git")).expect("git dir");
    write_file(&project.join("src/main.rs"), "fn main() {}\n");
    write_file(&project.join("AGENTS.md"), "keep the tests fast\n");
    write_file(&project.join(".git/config"), "[core]\n");
    let project_path = canonical(&project);

    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    state
        .db
        .set_project_memory(&project_path, "pinned project note")
        .expect("memory");
    // A project MCP server keeps its secret value in `.agents/mcp`, which the
    // archive must not copy verbatim.
    state
        .mcp_servers
        .upsert(crate::mcp_servers::McpServerInput {
            id: "project-server".into(),
            label: Some("Project MCP".into()),
            level: Some("project".into()),
            project_path: Some(project_path.clone()),
            transport: Some("stdio".into()),
            command: Some("server".into()),
            env: Some(std::collections::BTreeMap::from([(
                "PROJECT_TOKEN".to_string(),
                "super-secret-value".to_string(),
            )])),
            enabled: Some(true),
            ..crate::mcp_servers::McpServerInput::default()
        })
        .expect("mcp server");
    // A project skill is app-managed content inside the project folder; it
    // travels with the tree and is re-scanned on the other side.
    state
        .user_skills
        .create(crate::user_skills::UserSkillInput {
            id: Some("widget-skill".into()),
            name: Some("Widget Skill".into()),
            level: Some("project".into()),
            project_path: Some(project_path.clone()),
            body: Some("Use the widget workflow.\n".into()),
            enabled: Some(true),
            shape: Some("dir".into()),
            ..crate::user_skills::UserSkillInput::default()
        })
        .expect("skill");
    crate::scheduled::create_task(
        &state.db,
        &json!({
            "title": "Nightly",
            "prompt": "run the checks",
            "cadence": "daily",
            "workspacePath": project_path,
            "enabled": true,
            "schedule": { "hour": 9, "minute": 0, "weekday": 0 },
        }),
    )
    .expect("automation");

    let archive = source_dir.path().join("widget.zip");
    let summary = export(&mut state, &project, &archive);
    assert_eq!(summary["roots"], json!(1));
    // Three ordinary files plus the project skill document, while the MCP
    // definition that holds a secret is left out and rebuilt from the manifest.
    assert_eq!(summary["files"], json!(4));
    assert_eq!(summary["skippedSecretFiles"], json!(1));
    let manifest = read_archive_manifest(&archive);
    assert_eq!(manifest.projects.len(), 1);
    assert_eq!(
        manifest.projects[0].automations.len(),
        1,
        "the bound automation travels in the manifest"
    );
    assert_eq!(manifest.projects[0].mcp.len(), 1);

    let bytes = fs::read(&archive).expect("archive bytes");
    let portable = String::from_utf8_lossy(&bytes);
    assert!(
        !portable.contains("super-secret-value"),
        "an MCP env value must never travel in the archive"
    );
    assert!(!portable.contains(&project_path));

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let imported = import(target_dir.path(), &archive, &destination).expect("import");
    assert_eq!(imported["roots"], json!(1));

    let restored = canonical(&destination.join("widget"));
    assert_eq!(
        fs::read_to_string(Path::new(&restored).join("src/main.rs")).expect("restored file"),
        "fn main() {}\n"
    );
    // Hidden files and repository metadata are part of the copy.
    assert_eq!(
        fs::read_to_string(Path::new(&restored).join(".git/config")).expect("git config"),
        "[core]\n"
    );
    assert_eq!(
        fs::read_to_string(Path::new(&restored).join("AGENTS.md")).expect("agents"),
        "keep the tests fast\n"
    );

    let mut restored_state = AppState::open(target_dir.path()).expect("target state");
    assert_eq!(
        restored_state
            .db
            .get_project_memory(&restored)
            .expect("restored memory")
            .content,
        "pinned project note"
    );
    let servers = restored_state
        .mcp_servers
        .list(CapabilityLevel::Project, Some(&restored))
        .expect("restored mcp");
    assert_eq!(
        servers.len(),
        1,
        "the definition is restored from the manifest"
    );
    // The definition arrives disabled and without the secret value.
    assert!(!servers[0].enabled);
    assert!(servers[0].env.is_empty());
    let skills = restored_state
        .user_skills
        .list(CapabilityLevel::Project, Some(&restored))
        .expect("restored skills");
    assert!(
        skills.iter().any(|skill| skill.id == "widget-skill"),
        "a project skill travels with the project files: {skills:?}"
    );
    let tasks = crate::scheduled::list_tasks(&restored_state.db).expect("restored tasks");
    assert_eq!(tasks.len(), 1);
    // Execution ownership stays with the importing device.
    assert!(!tasks[0].enabled);
    assert_eq!(tasks[0].workspace_path.as_deref(), Some(restored.as_str()));
}

#[test]
fn exports_a_group_archive_with_ordered_roots_and_group_configuration() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let first = source_dir.path().join("first");
    let second = source_dir.path().join("second");
    write_file(&first.join("a.txt"), "first\n");
    write_file(&second.join("b.txt"), "second\n");
    let first_path = canonical(&first);
    let second_path = canonical(&second);

    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&first_path, false)
        .expect("first project");
    state
        .db
        .ensure_project(&second_path, false)
        .expect("second project");
    let group = state
        .db
        .create_project_group("Workspace", &[first_path.clone(), second_path.clone()])
        .expect("group");
    state
        .db
        .set_project_group_instructions(&group.id, "group guidance\n")
        .expect("group instructions");
    state
        .db
        .set_project_group_memory(
            &group.id,
            &json!([{ "id": "note", "title": "Note", "content": "group note" }]),
        )
        .expect("group memory");

    let archive = source_dir.path().join("workspace.zip");
    let summary = export(&mut state, &first, &archive);
    assert_eq!(summary["roots"], json!(2));

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let imported = import(target_dir.path(), &archive, &destination).expect("import");
    assert_eq!(imported["roots"], json!(2));
    assert_eq!(
        imported["projectPaths"],
        json!([
            canonical(&destination.join("first")),
            canonical(&destination.join("second"))
        ])
    );

    let restored_state = AppState::open(target_dir.path()).expect("target state");
    let restored_group = restored_state
        .db
        .project_group_for_path(&canonical(&destination.join("second")))
        .expect("restored group")
        .expect("group record");
    assert_eq!(restored_group.name, "Workspace");
    assert_eq!(restored_group.roots.len(), 2);
    assert_eq!(
        restored_state
            .db
            .get_project_group_instructions(&restored_group.id)
            .expect("group instructions"),
        "group guidance\n"
    );
    assert_eq!(
        restored_state
            .db
            .get_project_group_memory(&restored_group.id)
            .expect("group memory")
            .entries
            .expect("entries")
            .len(),
        1
    );
}

#[test]
fn refuses_to_overwrite_a_non_empty_folder_and_leaves_nothing_behind() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("project");
    write_file(&project.join("a.txt"), "a\n");
    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    let archive = source_dir.path().join("project.zip");
    export(&mut state, &project, &archive);

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    write_file(&destination.join("project/keep.txt"), "keep\n");

    let error = import(target_dir.path(), &archive, &destination).expect_err("conflict");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(destination.join("project/keep.txt")).expect("untouched"),
        "keep\n"
    );
    assert!(!destination.join("project/a.txt").exists());
    // A failed import leaves no staging directory behind.
    assert!(!target_dir.path().join("project-import").exists());
}

#[test]
fn rejects_archives_with_escaping_duplicate_or_unknown_entries() {
    let cases: Vec<(&str, Vec<(&str, &[u8])>)> = vec![
        (
            "escaping",
            vec![("manifest.json", b""), ("roots/0/../../evil.txt", b"evil")],
        ),
        (
            "unknown",
            vec![("manifest.json", b""), ("outside/file.txt", b"x")],
        ),
        (
            "outside-root",
            vec![("manifest.json", b""), ("roots/7/a.txt", b"x")],
        ),
    ];
    for (name, entries) in cases {
        let source_dir = tempfile::tempdir().expect("dir");
        let archive = source_dir.path().join(format!("{name}.zip"));
        let manifest = manifest_bytes(&one_root_manifest("project"));
        let mut rows = entries;
        rows[0].1 = &manifest;
        write_zip(&archive, &rows);
        let target_dir = tempfile::tempdir().expect("target");
        let destination = target_dir.path().join("restored");
        fs::create_dir_all(&destination).expect("destination");
        let error =
            import(target_dir.path(), &archive, &destination).expect_err("archive must be refused");
        assert!(
            error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
            "{name}: {error}"
        );
        assert!(
            !destination.join("project").exists(),
            "{name} created a destination"
        );
        assert!(
            !target_dir.path().join("project-import").exists(),
            "{name} left staging"
        );
    }
}

#[test]
fn rejects_a_symbolic_link_entry() {
    let source_dir = tempfile::tempdir().expect("dir");
    let archive = source_dir.path().join("link.zip");
    let manifest = one_root_manifest("project");
    let file = File::create(&archive).expect("zip file");
    let mut writer = ZipWriter::new(BufWriter::new(file));
    writer
        .start_file("manifest.json", SimpleFileOptions::default())
        .expect("manifest entry");
    writer
        .write_all(&manifest_bytes(&manifest))
        .expect("manifest bytes");
    writer
        .add_symlink("roots/0/link", "/etc", SimpleFileOptions::default())
        .expect("link entry");
    writer.finish().expect("finish");

    let target_dir = tempfile::tempdir().expect("target");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let error = import(target_dir.path(), &archive, &destination).expect_err("symlink");
    assert!(error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"));
    assert!(!target_dir.path().join("project-import").exists());
}

#[test]
fn skips_source_symlinks_and_reports_them() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("project");
    write_file(&project.join("a.txt"), "a\n");
    let outside = source_dir.path().join("outside.txt");
    write_file(&outside, "outside\n");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, project.join("escape.txt")).expect("symlink");

    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    let archive = source_dir.path().join("project.zip");
    let summary = export(&mut state, &project, &archive);
    #[cfg(unix)]
    assert_eq!(summary["skippedSymlinks"], json!(1));
    #[cfg(not(unix))]
    assert_eq!(summary["skippedSymlinks"], json!(0));

    let target_dir = tempfile::tempdir().expect("target");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    import(target_dir.path(), &archive, &destination).expect("import");
    assert!(destination.join("project/a.txt").exists());
    // A link out of the project is never followed into the archive.
    assert!(!destination.join("project/escape.txt").exists());
}

#[test]
fn stage_import_rejects_an_unknown_archive_version_without_staging() {
    let source_dir = tempfile::tempdir().expect("dir");
    let mut manifest = one_root_manifest("project");
    manifest.version = ARCHIVE_VERSION + 1;
    let bytes = manifest_bytes(&manifest);
    let archive = source_dir.path().join("future.zip");
    write_zip(
        &archive,
        &[("manifest.json", bytes.as_slice()), ("roots/0/a.txt", b"x")],
    );
    let target_dir = tempfile::tempdir().expect("target");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let error = import(target_dir.path(), &archive, &destination).expect_err("version");
    assert!(error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"));
    assert!(!target_dir.path().join("project-import").exists());
}

/// A hand-edited archive cannot inject MCP secret values into this machine: the
/// import reads only portable fields and clears the secret maps.
#[test]
fn import_ignores_secret_values_injected_into_the_manifest() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("guarded");
    write_file(&project.join("a.txt"), "a\n");
    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    state
        .mcp_servers
        .upsert(crate::mcp_servers::McpServerInput {
            id: "guarded-server".into(),
            label: Some("Guarded MCP".into()),
            level: Some("project".into()),
            project_path: Some(project_path.clone()),
            transport: Some("stdio".into()),
            command: Some("server".into()),
            ..crate::mcp_servers::McpServerInput::default()
        })
        .expect("mcp server");
    let archive = source_dir.path().join("guarded.zip");
    export(&mut state, &project, &archive);

    let mut manifest = read_archive_manifest(&archive);
    manifest.projects[0].mcp[0]["env"] = json!({ "INJECTED_TOKEN": "stolen-value" });
    manifest.projects[0].mcp[0]["headers"] = json!({ "Authorization": "stolen-header" });
    manifest.projects[0].mcp[0]["enabled"] = json!(true);
    let hostile = source_dir.path().join("hostile.zip");
    rewrite_manifest(&archive, &manifest, &hostile);

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    import(target_dir.path(), &hostile, &destination).expect("import");

    let restored = canonical(&destination.join("guarded"));
    let mut restored_state = AppState::open(target_dir.path()).expect("target state");
    let servers = restored_state
        .mcp_servers
        .list(CapabilityLevel::Project, Some(&restored))
        .expect("restored mcp");
    let server = servers
        .iter()
        .find(|record| record.id == "guarded-server")
        .expect("restored definition");
    assert!(
        server.env.is_empty(),
        "an injected env value must be dropped"
    );
    assert!(
        server.headers.is_empty(),
        "an injected header value must be dropped"
    );
    assert!(!server.enabled, "an imported definition stays disabled");
}

/// A failure after the automations were written must remove them again: the
/// group memory here is invalid, and the task was already inserted.
#[test]
fn failed_group_write_rolls_back_projects_folders_and_automations() {
    let source_dir = tempfile::tempdir().expect("dir");
    let mut manifest = one_root_manifest("faulty");
    // The integrity counts must match the single entry, so the import reaches
    // the group-memory step this test is about.
    manifest.roots[0].file_count = 1;
    manifest.roots[0].total_bytes = 1;
    manifest.projects.push(ArchiveProjectConfig {
        root: 0,
        memory: None,
        mcp: Vec::new(),
        automations: vec![json!({
            "id": "fault-task",
            "title": "Fault task",
            "prompt": "run it",
            "cadence": "daily",
            "enabled": false,
        })],
    });
    manifest.group = Some(ArchiveGroupConfig {
        instructions: String::new(),
        // An entry without an id is rejected by the group-memory setter, which
        // runs after the project configuration has been written.
        memory: Some(json!({ "entries": [{ "title": "no id" }] })),
    });
    let archive = source_dir.path().join("faulty.zip");
    write_zip(
        &archive,
        &[
            ("manifest.json", manifest_bytes(&manifest).as_slice()),
            ("roots/0/a.txt", b"a"),
        ],
    );

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let error = import(target_dir.path(), &archive, &destination).expect_err("group memory fails");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_IO:"),
        "{error}"
    );

    let mut state = AppState::open(target_dir.path()).expect("target state");
    let restored = destination.join("faulty").to_string_lossy().into_owned();
    assert!(
        state
            .db
            .list_projects()
            .expect("projects")
            .iter()
            .all(|project| project.path != restored),
        "the registered project must be rolled back"
    );
    assert!(
        !destination.join("faulty").exists(),
        "the created folder must be rolled back"
    );
    assert!(
        crate::scheduled::get_task(&state.db, "fault-task")
            .expect("tasks")
            .is_none(),
        "an automation this import inserted must be rolled back"
    );
    assert!(!target_dir.path().join("project-import").exists());
}

/// A single-root group with no group text is still a group: its name and
/// identity survive the round trip instead of degrading to a standalone project.
#[test]
fn restores_a_single_root_group_without_group_text() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let only = source_dir.path().join("only");
    write_file(&only.join("a.txt"), "a\n");
    let only_path = canonical(&only);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state.db.ensure_project(&only_path, false).expect("project");
    state
        .db
        .create_project_group("Solo workspace", &[only_path.clone()])
        .expect("group");
    let archive = source_dir.path().join("solo.zip");
    export(&mut state, &only, &archive);
    let manifest = read_archive_manifest(&archive);
    assert!(manifest.group.is_some(), "the group record is the marker");

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let imported = import(target_dir.path(), &archive, &destination).expect("import");
    assert!(imported["groupId"].is_string(), "a group must be created");

    let restored_state = AppState::open(target_dir.path()).expect("target state");
    let group = restored_state
        .db
        .project_group_for_path(&canonical(&destination.join("only")))
        .expect("group lookup")
        .expect("group record");
    assert_eq!(group.name, "Solo workspace");
    assert_eq!(group.roots.len(), 1);
}

/// An export target that reaches a project root through a symbolic-link parent
/// is refused before anything is written.
#[cfg(unix)]
#[test]
fn refuses_an_export_target_that_reaches_a_root_through_a_symbolic_link() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("project");
    write_file(&project.join("a.txt"), "a\n");
    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    let outside = source_dir.path().join("outside");
    fs::create_dir_all(&outside).expect("outside");
    let link = outside.join("link");
    std::os::unix::fs::symlink(&project, &link).expect("symlink");

    let plan = export_plan(
        &mut state,
        &json!({
            "projectPath": project.to_string_lossy(),
            "targetPath": link.join("archive.zip").to_string_lossy(),
        }),
        &silent,
    );
    let error = plan
        .err()
        .expect("target inside the project must be refused");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
        "{error}"
    );
    assert!(!project.join("archive.zip").exists());
}

/// The export refuses a file it could not import again, before writing a ZIP.
#[test]
fn refuses_a_project_file_above_the_import_entry_bound() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("huge");
    fs::create_dir_all(&project).expect("project");
    // Sparse: the size is real to the scanner, the bytes are not allocated.
    File::create(project.join("huge.bin"))
        .expect("file")
        .set_len(MAX_ENTRY_BYTES + 1)
        .expect("sparse size");
    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    let archive = source_dir.path().join("huge.zip");
    let plan = export_plan(
        &mut state,
        &json!({
            "projectPath": project.to_string_lossy(),
            "targetPath": archive.to_string_lossy(),
        }),
        &silent,
    );
    let error = plan.err().expect("oversized project must be refused");
    assert!(
        error
            .to_string()
            .starts_with("PROJECT_ARCHIVE_LIMIT_EXCEEDED:"),
        "{error}"
    );
    assert!(!archive.exists(), "no archive may be written");
}

/// An archive cannot smuggle app-managed MCP secret files back into a project,
/// whatever the separator or letter case it uses in their names.
#[test]
fn rejects_archives_that_carry_app_managed_secret_files() {
    let cases = [
        "roots/0/.agents/servers/leaked.json",
        "roots/0/.agents//servers/leaked.json",
        "roots/0/.AGENTS/Servers/leaked.json",
    ];
    for entry in cases {
        let source_dir = tempfile::tempdir().expect("dir");
        let mut manifest = one_root_manifest("project");
        manifest.roots[0].file_count = 1;
        manifest.roots[0].total_bytes = 5;
        let archive = source_dir.path().join("leak.zip");
        write_zip(
            &archive,
            &[
                ("manifest.json", manifest_bytes(&manifest).as_slice()),
                (entry, b"{\"env\":{\"TOKEN\":\"stolen\"}}"),
            ],
        );
        let target_dir = tempfile::tempdir().expect("target");
        let destination = target_dir.path().join("restored");
        fs::create_dir_all(&destination).expect("destination");
        let error = import(target_dir.path(), &archive, &destination)
            .expect_err("secret file must be refused");
        assert!(
            error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
            "{entry}: {error}"
        );
        assert!(!destination.join("project").exists());
        assert!(!target_dir.path().join("project-import").exists());
    }
}

/// Two entry names that normalize to one path are a duplicate, not a way to
/// write the same file twice.
#[test]
fn rejects_entries_that_normalize_to_the_same_path() {
    let source_dir = tempfile::tempdir().expect("dir");
    let mut manifest = one_root_manifest("project");
    manifest.roots[0].file_count = 1;
    manifest.roots[0].total_bytes = 1;
    let archive = source_dir.path().join("alias.zip");
    write_zip(
        &archive,
        &[
            ("manifest.json", manifest_bytes(&manifest).as_slice()),
            ("roots/0/a/b.txt", b"x"),
            ("roots/0/a//b.txt", b"y"),
        ],
    );
    let target_dir = tempfile::tempdir().expect("target");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let error = import(target_dir.path(), &archive, &destination).expect_err("duplicate");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
        "{error}"
    );
    assert!(!target_dir.path().join("project-import").exists());
}

/// The manifest states the archive's size; a different amount of content is
/// refused instead of imported.
#[test]
fn rejects_an_archive_whose_content_does_not_match_its_manifest() {
    let source_dir = tempfile::tempdir().expect("dir");
    let mut manifest = one_root_manifest("project");
    manifest.roots[0].file_count = 2;
    manifest.roots[0].total_bytes = 2;
    let archive = source_dir.path().join("padded.zip");
    write_zip(
        &archive,
        &[
            ("manifest.json", manifest_bytes(&manifest).as_slice()),
            ("roots/0/a.txt", b"x"),
        ],
    );
    let target_dir = tempfile::tempdir().expect("target");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let error = import(target_dir.path(), &archive, &destination).expect_err("count mismatch");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
        "{error}"
    );
    assert!(!target_dir.path().join("project-import").exists());
}

/// Two entries that a case-insensitive or normalization-insensitive volume would
/// treat as one file are refused instead of silently overwriting each other.
#[test]
fn rejects_entries_that_collide_across_filesystems() {
    let cases = [
        ("case", "roots/0/a.txt", "roots/0/A.txt"),
        ("case-in-name", "roots/0/readme.txt", "roots/0/README.txt"),
        (
            "nfc-vs-nfd",
            "roots/0/caf\u{e9}.txt",
            "roots/0/cafe\u{301}.txt",
        ),
    ];
    for (label, first, second) in cases {
        let source_dir = tempfile::tempdir().expect("dir");
        let mut manifest = one_root_manifest("project");
        manifest.roots[0].file_count = 2;
        manifest.roots[0].total_bytes = 2;
        let archive = source_dir.path().join(format!("{label}.zip"));
        write_zip(
            &archive,
            &[
                ("manifest.json", manifest_bytes(&manifest).as_slice()),
                (first, b"x"),
                (second, b"y"),
            ],
        );
        let target_dir = tempfile::tempdir().expect("target");
        let destination = target_dir.path().join("restored");
        fs::create_dir_all(&destination).expect("destination");
        let error = import(target_dir.path(), &archive, &destination)
            .expect_err("colliding entries must be refused");
        assert!(
            error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
            "{label}: {error}"
        );
        assert!(
            !destination.join("project").exists(),
            "{label} created a destination"
        );
        assert!(
            !target_dir.path().join("project-import").exists(),
            "{label} left staging"
        );
    }
}

/// Two roots whose names collide on a case-insensitive volume would be
/// extracted into one folder; the archive is refused before anything is written.
#[test]
fn rejects_root_names_that_collide_across_filesystems() {
    for (label, first, second) in [("case", "Repo", "repo")] {
        let source_dir = tempfile::tempdir().expect("dir");
        let mut manifest = one_root_manifest(first);
        manifest.roots[0].file_count = 1;
        manifest.roots[0].total_bytes = 1;
        manifest.roots.push(ArchiveRoot {
            index: 1,
            name: second.into(),
            file_count: 1,
            total_bytes: 1,
            skipped_symlinks: 0,
            skipped_secret_files: 0,
        });
        let archive = source_dir.path().join(format!("{label}.zip"));
        write_zip(
            &archive,
            &[
                ("manifest.json", manifest_bytes(&manifest).as_slice()),
                ("roots/0/a.txt", b"x"),
                ("roots/1/b.txt", b"y"),
            ],
        );
        let target_dir = tempfile::tempdir().expect("target");
        let destination = target_dir.path().join("restored");
        fs::create_dir_all(&destination).expect("destination");
        let error = import(target_dir.path(), &archive, &destination)
            .expect_err("colliding root names must be refused");
        assert!(
            error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
            "{label}: {error}"
        );
        assert!(!destination.join(first).exists());
        assert!(!target_dir.path().join("project-import").exists());
    }
}

/// The export refuses a project whose files collide on a case-insensitive
/// volume, so it never writes an archive this build would reject. A volume that
/// cannot hold both names is reported as skipped rather than silently passing.
#[test]
fn refuses_to_export_files_that_collide_across_filesystems() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("colliding");
    fs::create_dir_all(&project).expect("project");
    write_file(&project.join("probe.txt"), "probe");
    if project.join("PROBE.txt").exists() {
        // The test volume is case-insensitive, so it cannot hold the fixture.
        eprintln!("skipped: the test volume is case-insensitive");
        return;
    }
    write_file(&project.join("A.txt"), "a");
    write_file(&project.join("a.txt"), "b");
    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    let archive = source_dir.path().join("colliding.zip");
    let plan = export_plan(
        &mut state,
        &json!({
            "projectPath": project.to_string_lossy(),
            "targetPath": archive.to_string_lossy(),
        }),
        &silent,
    );
    let error = plan.err().expect("colliding files must be refused");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_INVALID:"),
        "{error}"
    );
    assert!(!archive.exists());
}

/// A symbolic link at the destination root would otherwise redirect the whole
/// tree outside the chosen parent; it is refused instead.
#[cfg(unix)]
#[test]
fn refuses_a_destination_root_that_is_a_symbolic_link() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("linked");
    write_file(&project.join("a.txt"), "a\n");
    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    let archive = source_dir.path().join("linked.zip");
    export(&mut state, &project, &archive);

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    fs::create_dir_all(&destination).expect("destination");
    let outside = source_dir.path().join("outside");
    fs::create_dir_all(&outside).expect("outside");
    std::os::unix::fs::symlink(&outside, destination.join("linked")).expect("symlink");

    let error = import(target_dir.path(), &archive, &destination).expect_err("symlink");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_CONFLICT:"),
        "{error}"
    );
    assert!(
        fs::read_dir(&outside).expect("outside").next().is_none(),
        "nothing may be written outside the destination"
    );
    assert!(destination.join("linked").is_symlink());
    assert!(!target_dir.path().join("project-import").exists());
}

/// A destination root that exists as a regular file is refused rather than
/// replaced.
#[test]
fn refuses_a_destination_root_that_is_not_a_folder() {
    let source_dir = tempfile::tempdir().expect("source dir");
    let project = source_dir.path().join("busy");
    write_file(&project.join("a.txt"), "a\n");
    let project_path = canonical(&project);
    let mut state = AppState::open(source_dir.path()).expect("source state");
    state
        .db
        .ensure_project(&project_path, false)
        .expect("project");
    let archive = source_dir.path().join("busy.zip");
    export(&mut state, &project, &archive);

    let target_dir = tempfile::tempdir().expect("target dir");
    let destination = target_dir.path().join("restored");
    write_file(&destination.join("busy"), "already a file");
    let error = import(target_dir.path(), &archive, &destination).expect_err("file");
    assert!(
        error.to_string().starts_with("PROJECT_ARCHIVE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(destination.join("busy")).expect("untouched"),
        "already a file"
    );
    assert!(!target_dir.path().join("project-import").exists());
}
