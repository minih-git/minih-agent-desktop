# 06. Plugin Packaging

## 1. Goals

Define how plugins are packaged, distributed, and installed, ensuring reproducibility across machines.

## 2. Package formats

### 2.1 Directory package (development/local)
A plain directory containing `manifest.json`.

### 2.2 Distribution package (recommended)
Extension: `.piplug` (essentially a zip)

```text
demo.hello-0.1.0.piplug
└─ (zip)
 ├─ manifest.json
 ├─ main.js
 ├─ renderer/...
 ├─ skills/...
 ├─ themes/...
 └─ checksums.json # optional, in-package manifest
```

> During implementation, `.zip` may be supported first, but at the product level everything is identified as `.piplug`.

## 3. In-package constraints

1. The root must contain `manifest.json`
2. Absolute-path symlinks are not allowed
3. Path traversal (`../`) is not allowed
4. Default max size after extraction for a single package (recommended 50MB, configurable)
5. Max file count (recommended 2000, configurable)

## 4. checksums.json (optional but recommended)

```json
{
 "algorithm": "sha256",
 "files": {
 "manifest.json": "hex...",
 "main.js": "hex..."
 }
}
```

The host can verify at install time.

## 5. Install flow

```text
select package/dir
 → verify archive safety
 → extract to temp
 → validate manifest + files
 → permission review UX
 → move to installed/<id>
 → registry write
 → optional auto enable
```

On failure, clean up temp and leave no half-installed directory.

## 6. Versioning and overwrite

- Installing a new version with the same id: upgrade
- Back up the old version to `cache/backup/<id>/<version>` before upgrade
- Rollback on upgrade failure (P2)

Semantics:
- `install`: id does not exist
- `upgrade`: id exists and version is newer
- `reinstall`: force reinstall of the same version

## 7. Uninstall and cleanup

Delete:
- `plugins/installed/<id>`
- registry entry

Optionally delete:
- `plugins/data/<id>`
- plugin logs

## 8. Development packages

Development loading does not go through `.piplug` packaging; instead:

```text
Load Development Plugin → choose directory → validate → register(source=dev)
```

## 9. Build recommendations (developers)

Minimal spec:

- Source can be TypeScript
- Compile to directly loadable js/html/css before distribution
- Do not rely on the host to run `npm install` for ordinary `.piplug` or development plugins (MVP does not pull dependencies at install time). The explicit Plugins → Import pi extension flow is the documented exception; its bounded npm behavior is defined in `16-trusted-extensions.md` §3.2.

If a plugin needs third-party libraries:
- Bundle them into the plugin directory yourself

## 10. Acceptance

1. Can install from a directory
2. Can install from `.piplug` / `.zip` (per milestone during implementation)
3. A bad package fails to install and leaves no residue
4. After upgrade, the id stays the same and the new version takes effect


## 12. Native assets in a package

A plugin that needs a native module ships it inside the package: the host never
runs `npm install`, a compiler, or downloaded code when a user enables a plugin.
Two rules keep such a package honest.

1. **What is packaged is what the runtime loads.** A native folder counts as
   present only when every file the module actually opens is there — for
   `node-pty`, `pty.node` plus the macOS `spawn-helper`, and the conpty DLL and
   console host on Windows. A folder missing one of them is a missing platform,
   not a partial one. Debug symbols and the legacy winpty shim are dropped.
2. **"It built" is not "it is deliverable".** A development package may carry a
   subset of the platforms, and its build output says so in those words. A
   package described as a delivery must name its platforms and fail the build
   when any of them has no asset; the staged directory is removed rather than
   shipped. A platform asset can only be produced by building on that platform
   (`npm_config_build_from_source=1 pnpm rebuild node-pty` for Linux), so a
   source-build directory for the host platform is packaged as that platform.

The terminal plugin implements this in `scripts/native-assets.mjs` (selection and
the missing-platform answer), `scripts/build.mjs` (`--require-platforms` gate) and
`test/native-assets.test.mjs` (fixtures describing folders, which is not a
platform run).

## 11. Implementation status

Implemented in host-core + desktop shell:

1. Directory install via `plugins.installFromPath`
2. `.piplug` / store-compressed zip install via `plugins.installFromPackage`
3. Marketplace download installs reuse the same package installer
4. Traversal / symlink / size / file-count guards are enforced before commit to `plugins/installed/<id>`
5. `plugins.inspectPackage` reads a `.piplug` the same way without installing it:
   it unpacks into `plugins/cache/inspect/<id>` under the same guards, returns
   the plugin id, name, version, declared permissions and the archive's SHA-256,
   and removes that directory before answering. Nothing installed is read for
   writing, and the checksum it returns is what an install must pass back as
   `expectedShasum` — a package replaced in between is refused as
   `PLUGIN_INTEGRITY` and the installed copy stays untouched.
