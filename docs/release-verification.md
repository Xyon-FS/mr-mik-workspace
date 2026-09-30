# Release verification — Mr. Mik

## 0.2.7 — Core Hub skill defaults

- Added focused tests for fresh public defaults, both agents' workspace Off/Inherit and preservation of existing scope bytes, plus compact orientation without full skill content.
- New starter defaults enable only workspace-authoring and feature-handoff. Existing Hubs are not seeded; native CLI discovery remains separate from Hub/Bridge scope switches.
- Full/light Hub archives carry the public defaults; snapshot imports preserve the destination's effective global defaults while applying workspace-level flags. Fresh portable checks assert exactly the two core skills are On for both agents.
- 161 service tests, production UI checks, ESLint and frontend compilation passed. No authenticated model request was made: the instruction guides skill selection but does not guarantee a model's semantic choices.
- Windows NSIS build, portable packaging, SHA-256 verification and bundled Node/ConPTY smoke checks passed. Bundled service files match the source; existing release folders and the personal Hub were left unchanged. Nothing was installed or published.

## 0.2.6 — Optional skills retained

- Both maintained skill sets contain 20 folders and 374 identical files. The four retained optional provider/dictation skills are included in source, runtime and portable packaging.
- Skill-pack tests verify Off defaults, global activation and per-workspace overrides independently for Codex and Claude. Missing-only installation preserves custom skill files and existing scope settings; no model or provider job is started.
- The dictation setup note is included with fresh portable Hubs and supplied by the installer runtime when missing. Conversational voice remains disabled. Hub controls do not override native CLI skill discovery rules.
- Updated the first-use guide for optional linked folders and card content navigation. Existing release folders and personal Hubs are not overwritten.
- 157 service tests, existing production UI checks, ESLint, frontend compilation and Windows NSIS build passed. No provider generation, authentication change or application restart was performed.

## 0.2.5 — Card content and actions

- Production browser checks cover right-aligned action menus, visible filled-dot icons, navigation inside card content, and all five demo pages at wide/narrow sizes. Card archive/restore/delete and existing multi-page, Markdown, terminal and tool interactions were regression-tested in isolated Hubs.
- The UI changes do not rewrite existing card files or change archive/snapshot formats. Personal Hubs are not migrated or overwritten.
- ESLint, frontend compilation, Windows NSIS build and clean starter/skill checks passed. Four focused example and transfer tests passed; existing service behavior was not otherwise changed.

## 0.2.4 — Midnight Workshop example

- 157 service tests passed, including example creation, idempotence, preservation of custom content, Hub-only workspaces and workspace snapshot export/import.
- ESLint, frontend compilation and clean source starter/skill checks passed. The source starter remains empty; new portable packages contain four public example cards, five HTML pages and one original SVG illustration.
- Production browser checks passed for existing chat, card, file, terminal and tool interactions. Every demo page was checked at wide and narrow widths, including section links, local image preview and download; screenshots were visually reviewed.
- Existing Hubs opt in through Workspaces → Add example workspace. No personal Hub, linked project, native credentials or skill/tool activation is changed automatically.
- Windows NSIS build and portable packaging passed, including SHA-256 checks, the bundled Node/ConPTY smoke test and clean public-demo Hub inventory. Nothing was installed or published.
- No authenticated paid model run or clean-PC acceptance is implied by these checks.

## 0.2.3 — First beta candidate

- 153 service tests passed, including 16 new card-removal cases: kept/archived/deleted selections, empty and orphaned cards, private recovery, rollback, selection revalidation, junction/shared-folder rejection, native recycle correlation, open-chat protection, transfer lock behavior and Hub archive/snapshot boundaries.
- ESLint, frontend compilation and clean starter/skill checks passed: 16 maintained skills, 361 matching Codex/Claude files.
- Isolated browser checks cover card right-click/actions, Archive/Restore/Delete, custom confirmations, workspace name and retained cards moving to Global Hub. Native recycling is simulated for browser/service tests; personal cards and native transcripts are not deleted for testing.
- Existing production UI checks also passed for Help, Markdown editing, Codex/Claude MCP controls, hidden credentials, terminal links/copy/scroll and PowerShell interruption. An outdated test label was aligned with the current Claude control; its application behavior was not changed.
- The approved 0.2.1 unstriped cap remains unchanged. Source and native application versions are aligned at 0.2.3.
- Windows NSIS build and separate clean portable packaging passed; installer/ZIP SHA-256 checks and the bundled Node/ConPTY smoke test passed. Existing 0.2.1 release/Hub is preserved. No app was installed or published.
- `fflate` is now 0.8.3; the service dependency audit reports zero known vulnerabilities. No blanket dependency update was performed.
- This is a beta candidate, not a claim of clean-PC acceptance or paid authenticated Claude/Kimi coverage. Archives and overview screenshots can contain private material; review before publishing.

## 0.2.2 — Larger striped cap

- Both workspace/chats SVGs updated and native icons regenerated; visual inspection at 128 and 32 pixels confirmed visible stripes and a wider, flatter cap.
- Production frontend and Windows NSIS build passed; runtime SVGs match the edited source exactly.
- Clean starter and Codex/Claude skill-copy checks passed. No behavior, archive or snapshot schema changes.

## 0.2.1 — Skill pack and icon

- Six new skills passed skill-creator frontmatter validation; their VFX implementation reference is included.
- 35 focused service tests passed: new pack defaults/agent parity/global and workspace overrides, missing-only installation, preservation of custom folders and scope bytes, external-junction rejection, project/Bridge operations and workspace snapshot transfer cases.
- ESLint, production frontend build and clean template checks passed: 16 maintained skills and 361 matching Codex/Claude files, with no personal state or native configuration in the starter.
- SVG/native icons regenerated and the enlarged cap visually inspected.
- Existing 0.2.0 release and its potentially used Hub are not overwritten; 0.2.1 is packaged separately.
- Hub switches gate Bridge discovery/reads; native Codex discovery inside the Hub root is unchanged.
- Windows NSIS build, clean source copy, portable/installer checksums, bundled Node/ConPTY and bundled missing-pack installation passed. The runtime installed exactly six disabled skills for each agent in an isolated empty Hub; no native model/authentication was used for this check.
- Distribution parity checks found four stale Claude-only provider/voice folders. Packaging now excludes names absent from the maintained canonical set, without deleting source or existing Hub folders.

## 0.2.0 — Historical release verification

Verified on Windows x64 with Node 24.19.0; root minimum is Node 22.20.0. Changes were implemented in an isolated clean source copy, not the original personal Hub. Nothing was installed, published or migrated into native CLI authentication profiles.

- Production frontend build and ESLint: passed.
- Node service suite: **134 tests passed**, including full/light Codex and Claude incremental archive transfer, native-session identity, scopes, Bridge operations and six workspace-snapshot cases (including transfer-failure rollback).
- Clean starter validation: no personal cards/projects/state/native settings, 10 maintained skills, 354 matching Codex/Claude skill files.
- Isolated production UI: private archive preview, Claude parity, coordinator scope/actions, terminal controls and snapshot conflict confirmation passed. Models/PTYs are simulated for UI operations; this is not a paid authenticated Claude model run.
- Runtime startup diagnostics: PID/origin only; authenticated ready URLs still pass on the private native pipe without being logged by the test.
- Large/BOM/partial Codex metadata: passed with a bounded 2 MiB first-record reader.
- Report fallback controls and relative preview URL calculations: passed. The fallback render is tested directly, not as a claim that every possible report viewer failure was browser-injected.
- Native build: Windows NSIS installer built with application identifier `com.mrmik.workspace`. Portable and checksum packaging is local only.
- Installer/portable SHA-256 hashes, ZIP required-file inventory, clean portable Hub and bundled Node/ConPTY smoke test: passed. No real agent was started.
- Fresh source-copy install (`npm ci`), frontend build and starter checks: passed independently of the development copy's dependencies/cache.

The optional upstream game-skill pack remains a reviewed candidate set, not automatically installed/enabled. The moderate `fflate` advisory remains documented in SECURITY.md. Native live chat/provider acceptance depends on the destination machine's CLI version/account, and Windows preferences remain machine-local. Review exports before sharing.
