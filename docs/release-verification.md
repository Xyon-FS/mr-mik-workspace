# Release verification — Mr. Mik

## 2026-10-02 — Installed-app Hub setup (0.2.9 rebuild)

- First launch now offers Create a new Hub / Open an existing Hub. New-Hub creation uses a separately bundled clean starter template shared with portable packaging. Existing Hub folders are not initialized or overwritten; a missing remembered path prompts again. Portable's explicit MyHub launcher remains unchanged.
- Service regression: 289 tests passed. New tests create an isolated Hub with four starter cards and matching skill defaults, reject an existing populated or empty folder without changing its contents, and reject an invalid template before creating the destination. ESLint, TypeScript/frontend build and clean-template/skill-parity checks passed.
- Release verification additionally runs the initializer with bundled Node in a disposable directory, checks starter content/defaults and verifies repeated creation is refused without changing the marker. Native dialog interaction still requires a first-launch manual check; tests do not modify the user's remembered Hub or interrupt an existing app.
- Installer/portable are rebuilt at the unchanged 0.2.9 version. Previous release artifacts are retained separately as a backup; no GitHub assets or tags are changed by this task.

## 2026-10-02 — Offline CI History fixture correction

- The OpenCode History unit test mocked terminal launch but still invoked the real version/storage boundary. This passed on an OpenCode-equipped workstation and failed on the clean GitHub runner. The fixture now mocks that boundary and asserts its exact session/native-ID arguments and single invocation; production checks are unchanged.
- All eight OpenCode unit tests pass with only Windows system directories on PATH. Full regression with agent installations excluded from PATH: 287 tests, 284 passed, three existing installed-Codex acceptance checks skipped, zero failures. No OpenCode installation was added to CI, and the failing test was not skipped.
- Only test and documentation files changed. Existing 0.2.9 installer/portable packages remain valid; no app rebuild, account action or native chat launch is required for this correction.

## 2026-10-02 — 0.2.9 compact provider controls

- Final pre-push regression: all 287 service tests passed. Source/privacy-path checks and ignore rules exclude runtime state, native conversation files, credentials, build caches and release binaries. GitHub publication of release assets remains a separate maintainer action.
- OpenCode connection now uses an icon-only 28 px plus action with tooltip, accessible name and keyboard focus. Provider rows are visually nested; the post-launch authentication notice is shortened without claiming authentication succeeded. README/Help reflect the icon.
- Version labels aligned at 0.2.9, including npm/native metadata, health and snapshot manifests. Distributable naming uses plain incremented versions without preview suffixes; existing packages and user Hubs remain unchanged.
- ESLint, TypeScript/frontend build, six targeted account/Help/version tests, clean-template checks and production Accounts UI passed. UI covers multiple providers, unknown/unavailable status, environment-only connections, keyboard focus and 220 px narrow layout; screenshot visually reviewed. Authentication was mocked, not executed.
- Windows executable and installer rebuilt. `release/0.2.9` installer/portable checksums, clean MyHub defaults, bundled adapter parity and Node/SQLite/ConPTY verified. Nothing installed, published, committed or restarted; no user account or active agent session changed.

## 2026-10-02 — 0.2.8 current-copy audit

- Audited current Help, Accounts/transfer/project UI copy and OpenCode integration reference against implemented adapters. Removed stale unreleased/source-only claims; documented V1/V2 plugin distinctions, core Hub skill defaults, protected native refresh and explicit unavailable-conversation exclusions. Historical changelog/verification entries remain historical.
- Corrected health/snapshot version projections to 0.2.8 and clarified restored workspace preference versus open-chat/window state. Added Help-content/version regressions and a production Help assertion for the current V2 transfer heading.
- ESLint, TypeScript/frontend build, 17 targeted Help/native-refresh/snapshot tests, production Help/general UI and transfer UI passed. The transfer fixture was updated from the obsolete aggregate OpenAI account shape to the current provider-list contract; no authentication was executed.
- Windows executable/installer rebuilt and separate `release/0.2.8-help-preview-1` packages verified for checksums, clean starter defaults, bundled service parity and Node/SQLite/ConPTY. These packages include the corrected Help; the prior `release/0.2.8` artifacts remain unchanged. No user Hub, account or running application changed; nothing published or committed.

## 2026-10-02 — 0.2.8 first-use and Accounts release

- Application/npm/native metadata aligned at 0.2.8. README and getting-started guidance revised for practical first use, agent setup, App/MyHub updates and current OpenCode support.
- Accounts production UI passed with grouped providers, exact provider confirmation payloads, environment-only connections, no connected providers, unknown status and unavailable CLI. Buttons and labels fit a 220 px account list; screenshot visually reviewed. Four account unit tests passed without executing authentication.
- ESLint, TypeScript/frontend production build, clean-template checks (20 maintained skills, 374 identical Codex/Claude files) and diff whitespace checks passed. The existing frontend bundle-size warning remains.
- Windows executable and NSIS installer rebuilt; `release/0.2.8` installer/portable checksums, clean MyHub defaults, bundled source parity and Node/SQLite/ConPTY tests passed. Existing Hubs/releases preserved. Nothing installed, restarted, published or committed. The previous 285-test service regression remains the baseline; this UI/docs/version update used targeted account tests rather than rerunning the whole suite.

## 2026-10-02 — Preview 16 packaging

- Windows release executable and NSIS installer rebuilt successfully with the provider-account and explicit partial native-transfer changes.
- Separate `0.2.7-opencode-preview-16` installer and portable ZIP generated. SHA-256 checks, source/bundled-service parity, clean MyHub inventory, default skill states and bundled Node/SQLite/ConPTY checks passed.
- Existing packages and user Hubs preserved. Nothing was installed, published or restarted; no native agent/account was started. The earlier partial-transfer entry's unbuilt-package limitation is resolved by preview 16.

## 2026-10-02 — Explicit partial native transfer

- All 285 service tests passed. New isolated Codex/Claude and OpenCode V1/V2 cases verify confirmed exclusions, healthy context transfer, unavailable History warnings, no silent fresh-context launch, preserved local History, missing declared native entries, isolated invalid transcripts, fatal present-file checksum mismatches and stale review rejection.
- Production transfer UI passed with unavailable import/export entries: import/export remain disabled until explicit exclusion consent; attachment consent is independent; exact skip identities, export token and import archive hash are submitted. No native account or provider calls were made.
- ESLint, TypeScript/production frontend build and diff whitespace checks passed. The existing bundle-size warning remains.
- In-app Help, worker/Mik History warnings and changelog updated. Installer/portable packages have not been rebuilt for these changes; preview 15 is still the prior distribution.

## 2026-10-02 — Provider accounts and complete-export follow-up

- 281 service tests passed. New fixtures cover multi-provider metadata projection, environment-only connections, native provider commands, safe confirmations, missing Codex/Claude native IDs/transcripts, coordinator context and explicit light-export fallback.
- ESLint and TypeScript/production frontend build passed (the existing bundle-size warning remains).
- Production account UI fixture passed: provider-specific rows/actions, no logout for environment-only V2 connections, correct confirmation payloads and generic Connect provider. Authentication was fully mocked; no login/logout command was executed.
- Help and changelog updated. Analysis-only results are in `platform-follow-up-audit.md`; no external-change monitoring or additional native transfer traversal was implemented.
- Installer and portable were **not** repackaged for this follow-up. Preview 15 below remains the earlier package; these edits currently exist in source and the rebuilt frontend.

## 2026-10-02 — V2 final regression

- All 279 service tests passed, including Codex/Claude archive regressions, V1/V2 format discrimination, scopes, the App/MyHub boundary, family conflicts, controlled deletion, rollback and Windows reader-lock handling.
- ESLint, TypeScript/production frontend build and clean template checks passed: 20 maintained skills, 374 identical Codex/Claude skill files, no personal starter state/configuration.
- Production browser checks passed for files/skills/tools, terminal links/copy/scroll, cards/demos, OpenCode chat controls, family deletion review and full-transfer previews. Browser PTYs and providers are simulated; the transfer preview screenshot was visually reviewed.
- Native V1 two-profile tests passed for continuation replacement, conflict/stale guards, family relinking/deletion and explicitly approved file/tool attachments. These use isolated profiles, not the user's chats.
- The native V2 stress fixture reproduced lost state publication under Windows reader locks; bounded coalesced retries preserve the newest state. A separate control-file reader lock was reproduced during TUI acceptance; publication now retries the same request ID, checking the launch before delivery. Deterministic regressions verify no duplicate request and cancellation on a changed chat. Repeated twelve-round form/reply runs pass without retaining form content or answers.
- Native test providers/MCPs use localhost fixtures. Authenticated paid-provider and clean-PC/installer acceptance remain separate user checks. No personal account, CLI installation or live application session is changed by these tests.
- Full V2 native server/ConPTY acceptance passed after the corrections: twelve consecutive form/reply cycles, native skill catalog, verified plugin identity/exclusion/re-enable, model/variant, protected drafts, provider-error recovery, submit/interrupt, same-ID resume without replay, distinct native fork, approved media, family continuation, injected rollback/partial-import cleanup and recursive deletion that retains independent forks. V1 interactive model/variant/fork and live MCP Off/On checks also passed without paid provider calls or server-tool invocation.
- Windows NSIS build and separate `0.2.7-opencode-preview-15` packaging passed. Installer/portable SHA-256 verification, clean MyHub inventory/default skill states, bundled service/adapter byte parity, bundled Node SQLite and Node/ConPTY smoke checks passed. The in-app Help includes the updated V2 guide. Existing releases/Hubs are preserved; no installer was run, user application restarted or asset published. Build caches are outside the source in `Documents/Codex/mik-build-target` and are not distribution contents.

## 2026-10-02 — MCP updates in open chats

- All 217 service tests passed, including effective scope filtering, protected drafts/tasks, same-conversation resume, Bridge editor notification and exclusion of runtime refresh state from transfer archives.
- ESLint, frontend build, Windows native build and the production OpenCode UI check passed.
- Native OpenCode tests in an isolated profile verified live MCP Off/On, connection of a server disabled at launch, draft protection, model/variant selection, provider-error recovery, submit, abort and fork identity. Only localhost fixtures were used; no account or paid calls.
- Preview 14 installer/portable checksums, bundled Node/ConPTY and clean starter Hub checks passed. Nothing was published and no active user app was restarted.
- Authenticated Codex/Claude restart/resume acceptance remains a user check. Native skill synchronization is deferred; see [mcp-chat-updates.md](mcp-chat-updates.md).

## OpenCode preview — contract-based compatibility

- Removed the exact 1.18.34 transfer/deletion pin and launch's major-version
  allowlist. Release numbers are diagnostic, not compatibility permission.
- Schema validation checks every database field actually read, accepts extra
  tables/columns and closes failed read-only handles. Existing JSON, ownership,
  family, concurrency, backup and isolated-import checks remain in place.
- Missing native TUI route/catalog/readiness/dispatch/abort contracts return
  per-control errors without guessing input. An unavailable dispatch does not
  disable an independently available native abort.
- All **205 service tests** passed sequentially, including future-version parsing,
  compatible extended schemas, missing tables/fields and missing TUI capabilities.
  These are compatibility fixtures, not execution of an actual future CLI.
- Native standalone/family import, continuation, conflict refusal, selective and
  recursive deletion, and reviewed file/tool attachment round-trips passed in
  isolated profiles on installed CLI **1.18.34**. No provider/account calls were
  made. Future releases still need real acceptance; structural checks cannot
  establish every upstream semantic change in advance.
- ESLint, frontend/native Windows build and the production OpenCode UI check
  passed. No active app/session was restarted or published assets overwritten.
- User-reported authenticated Bridge-content and skill checks are distinct from
  automated coverage. Real MCP, restart/resume and second-environment acceptance
  remain separate checks.
- Inspection-only cleanup candidates are recorded in
  [code-cleanup-audit.md](code-cleanup-audit.md). No candidate was removed.

## Post-release CI portability correction

- GitHub's clean Windows runner exposed three command-construction tests relying on an installed Codex CLI and one terminal attachment timeout. Local results alone had not covered that environment.
- The three tests now assert an isolated npm command fixture, which throws if executed, and restore their environment afterward. No Codex installation, login or test skip is required.
- Attachment coverage waits for the PowerShell prompt instead of a fixed delay, uses a wide terminal for long checkout paths and asserts the exact literal input with no Enter. The native screen assertion remains enabled.
- All 161 local service tests, lint, clean-template checks and frontend build passed after correction. GitHub runner validation is separate. Release 0.2.7 assets and tag are not rewritten.

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
# MCP chat update verification — 2026-10-02

- Scoped MCP fingerprints and guarded same-conversation resume have targeted regressions for overrides, drafts, native dialogs, missing IDs, failures, concurrent changes and Bridge/UI editor notifications.
- Native OpenCode 1.18.34 was exercised in an isolated profile against localhost MCP/provider fixtures: empty-prompt detection, draft rejection and verified disconnect/reconnect without process restart. No real account, paid provider request or MCP tool invocation was used for these connection checks.
- Runtime update status is excluded from saved session metadata and portable exports; restored sessions rebuild their launch baselines. Native skill reload remains a separate follow-up.
- Authenticated Codex/Claude idle-prompt/resume checks remain user smoke tests; no running user chat was stopped by development verification.
