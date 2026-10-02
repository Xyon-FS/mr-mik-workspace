# Changelog

## 0.2.10 — Native Hub authoring and safer chat permissions

- Codex permission changes now automatically restart/resume the same chat in-place when idle with an empty prompt and no native dialogs. Busy requests/drafts wait; failed preflight never stops the CLI and failures do not loop. Fixed terminal filtering that incorrectly dropped native focus/blur notifications. Added an isolated live-tick UI test; confirmation of the reported Codex Working timer still requires a real active turn.

- Isolated portable launch profiles from the installed app, including saved Hub selection, native window preferences and single-instance routing. Opening the portable or an explicit `--repo` Hub no longer replaces the installed app's remembered Hub. Direct portable executable launches discover their sibling MyHub (legacy Hub also supported). Native agent accounts/configuration remain unchanged and shared.

- Added three Codex worker permission choices: native CLI configuration, full filesystem access with user approvals on request, and existing bypass. Defaults, per-chat changes, resume/fork and transfer preserve the choice. Open chats automatically resume with the new mode when safe; tool refresh waits for pending permission changes. Claude, OpenCode, Kimi and Mik coordinator permissions are unchanged. Temporary-folder management remains deferred.

- Hub content authoring now resolves scoped file destinations, uses native CLI file tools, and registers metadata without sending HTML/Markdown through MCP. Legacy Bridge document writes are disabled, including Context saves and skill creation. Permission denials have no writing fallback. Codex adds existing content roots only for an explicit workspace-write sandbox without custom profiles; Claude uses additional directories; OpenCode retains native external-path approvals. Mik remains read-only and delegates document authoring to visible workers. Updated authoring instructions and regression coverage.

- Removed the temporary Cursor diagnostics overlay, report helper, sampling timer and parser counters. OpenCode cursor contrast and safe scrollback clearing remain unchanged; their UI tests now inspect the rendered cursor directly. Help documents native Codex usage/status commands.

## 0.2.9 — Compact provider controls

- Simplified installed-app first launch with Create a new Hub and Open an existing Hub. New Hubs use Documents/Mr. Mik/MyHub or a new MyHub in a chosen parent folder, include the portable starter examples/skills, and never overwrite existing folders. The selected path is remembered; missing saved Hubs prompt again. Portable startup remains direct. Updated first-use documentation; app version remains 0.2.9.

- Fixed the offline OpenCode History unit test accidentally probing the installed CLI during resume. Native version/storage preflight is mocked explicitly; observed-ID recovery and native-boundary invocation remain asserted. CI does not need OpenCode installed for this test; application behavior is unchanged.
- Replaced OpenCode's text Connect button with a compact, keyboard-accessible plus icon and Connect provider tooltip. Connected providers remain grouped with their own status/sign-out controls; the native-authentication notice is shorter without implying successful login.
- Distributable builds now use plain incremented app versions without preview suffixes. Updated app, npm/native metadata, health and workspace-snapshot version labels; previous release packages and user Hubs remain untouched.

## 0.2.8 — OpenCode integration and first-use guidance

- Audited current Help and interface copy: removed obsolete OpenCode unreleased/source-only labels, corrected V1/V2 plugin/transfer distinctions, core skill defaults, protected native refresh and explicit partial transfer. Clarified account grouping and restored workspace preferences versus open-chat/window state. Updated health/snapshot version labels and added Help-content regressions.
- Bumped application, npm lockfile and native package metadata to 0.2.8. Grouped OpenCode accounts under one heading with a compact Connect action and individual provider status/sign-out rows; narrow panels wrap status instead of clipping controls.
- Rewrote README around practical uses, first launch, agent setup, a first workspace/card workflow, safe updates and private transfer. Retained upstream attribution and platform limits; corrected outdated OpenCode and installer/portable Hub guidance.

The entries below record intermediate stages and their then-pending work; consult the user guide and release verification for current support.

- Added explicit partial full-transfer review for Codex, Claude and OpenCode V1/V2. Unavailable native contexts/families can be excluded after confirmation without blocking healthy conversations; available History/screens retain a transfer warning, and existing local contexts are preserved. Export choices are fresh/single-use; import confirms the reviewed archive hash and exact unavailable set. Missing declared native files and invalid individual transcripts are isolated, while unsafe manifests/paths, present-file integrity failures and identity overlap remain fatal. Native write failures retain existing backup/recovery behavior. Added all-platform partial-transfer and production-UI confirmation regressions; updated in-app Help and Mik/worker History warnings.

- OpenCode Accounts now discovers connected native providers instead of targeting OpenAI. V2 uses safe integration IDs and hides logout for environment-only connections; V1 falls back to the native picker when identities cannot be established. Unconnected providers remain accessible through Connect provider. No credential files, account labels or raw authentication output are stored or exported.
- Full Codex/Claude Hub export now checks every non-empty managed chat and saved Mik native context. Missing IDs or missing/ambiguous/unreadable transcripts explicitly block the archive and identify affected chats; light export remains an explicit History-only alternative. Added regression coverage and updated in-app Help. Skill catalog, family/attachment coverage and external-change monitoring findings are documented in the platform follow-up audit; no new monitoring or plugin controls were added.

- Final local preview `0.2.7-opencode-preview-15`: 279 service tests, production UI checks, real isolated V1/V2 native acceptance, clean-template checks, lint and frontend/Windows builds passed. Installer and App/MyHub portable packages were rebuilt and verified for checksums, clean starter defaults, adapter parity and bundled SQLite/ConPTY support. Nothing was installed or published; clean-PC and authenticated provider acceptance remain separate. Earlier entries below record intermediate implementation stages and their then-pending work.

- Final regression: corrected intermittent V2 observer-state loss when Windows readers briefly prevent atomic file replacement. Bounded, coalesced retries retain the newest revision without blocking native events or replaying model requests; disposal cancels pending retries. Picker request publication also retries the same file/ID under temporary reader locks, checks the current launch before delivery and never generates a duplicate command. Added deterministic lock regressions and a twelve-round native form/reply stress fixture. Updated the V2 integration guide and in-app Help to describe implemented family, continuation, attachment and fork portability rather than the earlier standalone-only limits.

- Added bounded V2 parent/child-family export/import/update and recursive native deletion (64 sessions, depth 16, same working folder, 64 MB envelope). Complete topology, message ownership, subagent references and separately associated History children are checked before mutations; divergence anywhere keeps the local family. Native imports validate parents before children, and partial replacement failures restore the entire original family. Confirmed partial fresh imports are cleaned up only when their content matches the reviewed plan; uncertain/foreign data keeps a recovery lock and cannot silently attach to History. Independent V2 forks transfer their copied history/ID and `mrMikFork` metadata provenance, not the native fork-boundary link that native import does not recreate. Native DB writes remain delegated to OpenCode. Existing revert/cross-location/queued-work limits remain. Desktop packages have not been rebuilt.

- Added guarded same-ID V2 continuation replacement for exact-prefix histories. Incoming and rollback imports are prevalidated in disposable native databases; a durable verified recovery backup and database/session-scoped Mik lock precede deletion. Destination permissions are retained, newer local histories and divergent branches are preserved, and changed sessions stop before mutation. Failed imports restore the original through native commands and verify it; unverified recovery retains the backup/lock and reports a manual-recovery error without connecting History. Real isolated native tests verify same-ID updates and an injected post-delete import failure/rollback. This is not an atomic cross-application database transaction or a crash-recovery service; all clients using the session must be closed. Family/fork updates remain pending. Desktop packages are not rebuilt.

- Added V2 attachment transfer through the existing explicit export-review flow. Prompt files retain their historical base64 bytes and become inline portable attachments, without rereading their original paths. Local tool-file references are embedded only after a fresh, single-use approval with unchanged file/chat checks; remote/private/missing/linked paths remain refused. Imports validate self-contained content through the native disposable-database preflight. Added archive/security regressions and a real isolated V2 native media round-trip. Same-ID continuation replacement and family/fork portability remain pending; desktop packages have not been rebuilt.

- Corrected V2 native skill controls to use folder/filename IDs rather than frontmatter display names. Discovery includes direct Markdown, nested `SKILL.md`, singular/plural skill directories and configured paths relative to the working folder. Owned V2 chats can supply a bounded native metadata catalog, including already-loaded remote sources; Mik does not download these sources or retain instruction bodies. Native approval requirements are shown separately from enablement and permission changes participate in guarded refresh. Hub-root native suppression also uses actual V2 IDs. Native form/permission events now preserve attention across concurrent dialogs without persisting questions or answers. Unit regressions and an isolated real V2 server/ConPTY fixture pass; installer/portable artifacts are not rebuilt by this step.

- Added a separate native V2 transfer/deletion adapter and archive format marker without changing legacy archive compatibility. Standalone settled typed-message histories export/import through native `session` commands, relink to the destination folder, deduplicate and require verified deletion receipts. Private command profiles retain only the target database path, not personal auth/config. Disposable-database import validation precedes destination writes. V2 create-only imports never delete/overwrite an existing conversation to resolve a continuation conflict. Fork/child/revert dependencies, queued/unsettled history, cross-folder moves and external attachments remain guarded. Real isolated V2 tests cover cross-database restore, duplicates, source/config preservation and controlled deletion.

- Added verified V2 server-plugin identities from the owned native chat, excluding builtin/SDK components and Mik's Bridge controls. Tools and approved Bridge requests can add/remove exact-ID exclusions without copying plugin options or credentials. Unknown IDs and inherited/wildcard exclusions stay guarded; proof is runtime-only and must be reacquired after reopening Mik. An isolated native terminal test confirms identification, disablement and re-enablement without a model call. Restored locked development dependencies and verified the TypeScript/frontend production build.

- Extended protected chat refresh to declared native skills and plugins, including plugin-only configurations without MCPs. Native skill switches, linked-skill creation and Markdown saves through Mik trigger effective per-chat comparison. Skill instructions and plugin options are retained only as private runtime hashes. Hub Bridge skill controls remain separate. Native changes use guarded same-conversation resume rather than pretending to be live MCP reconnects; busy chats, drafts and unknown layouts stay pending. External file watching, auxiliary skill assets and verified V2 plugin-ID controls remain follow-ups.

- Added V2 MCP/skill configuration inspection and editing: native `mcp.servers`/`disabled`, replacement rather than false deep inheritance, ordered skill allow/deny rules, configured skill paths and sanitized read-only plugin declarations. Project MCP overrides retain full safe options/references and refuse automatic copying of sensitive literal credential fields. Inherit removes only an unchanged generated override. Added V2 native account syntax and metadata-only status parsing; isolated native MCP connection/auth-status smoke uses no personal accounts.
- Added the V2 native TUI entrypoint for Model/Variant and Send/Stop, with public catalog projection, launch-scoped receipts and native session interruption. Verified real ConPTY model/variant changes, draft-safe worker delivery, interruption without terminal restart and picker recovery after a mocked provider failure at a resized width. Native forms/permissions, foreign chats and stale requests fail closed; hot reload keeps ephemeral receipt identity to prevent duplicate commands. V1 controls remain unchanged; V2 account/config/transfer and native skill refresh remain pending.
- Added initial OpenCode V2 runtime routing with per-chat standalone servers, a directory-packaged V2 context/event plugin and preassigned native IDs to avoid missing session creation during delayed plugin loading. V1 retains its adapter. Verified private-server Bridge bootstrap, compact orientation, native activity/preview and same-ID continuation using CLI 2.0.21 with an isolated local mock provider. V2 TUI controls, account/config management and transfer remain in progress; this is not a full V2 compatibility claim.
- Verified V2 lifecycle through real Windows ConPTY: new empty chat, scoped prompt, close/resume without replay and distinct native fork. Native forks are created through the private native API before terminal startup, avoiding missed plugin events. V2 resume and MCP-restart preflight inspect exact native IDs in read-only storage; missing/invalid IDs cannot silently create a new conversation. Additional schema columns and later patch versions remain accepted.

- Portable packaging now separates replaceable `App/` from persistent `MyHub/`; the launcher supports legacy `Hub/` and explicit external Hub paths without copying or overwriting content. Release verification follows the new layout. Existing releases and personal Hubs are not moved.
- OpenCode executable resolution now follows the selected PATH installation instead of preferring a stale V1 npm binary. Standard V1/V2 npm shims resolve their own package; `MRMIK_OPENCODE_BINARY` supports explicit isolated development paths. Version probes use the same executable arguments and environment.
- Legacy native transfer refuses V2 session storage even when migration leaves V1 tables in place, preventing stale-data export/deletion. This is a storage-format guard, not a release-number restriction; full V2 integration remains in progress.

- Added scoped MCP updates for open chats. Effective configuration fingerprints avoid restarting unrelated agents or locally overridden folders. Existing OpenCode On/Off connections can update live; definition changes and Codex/Claude use guarded same-conversation resume. Busy chats, drafts, native dialogs and missing conversation IDs remain pending with a compact manual action. Failed updates do not retry automatically. Runtime fingerprints/status are excluded from portable archives; native skill synchronization remains a separate follow-up.
- Removed OpenCode's exact-release and major-version allowlists. Launch accepts discovered later versions; transfer/deletion validate required database fields and native JSON/import behavior instead. Missing TUI contracts fail per control without guessed input. Added compatibility regressions and an inspection-only cleanup audit.
- Moved Workspace's Restore layout shortcut to the bottom of the right rail beside Show Chats, keeping the top bar focused on card actions.
- Distinguished Restore layout with an outward-arrows icon and removed its artificial inter-window gutter.
- Removed the lengthy experimental OpenCode notice from New chat (integration limits remain documented in Help). Added compact Restore default window layout buttons in Chats and Workspace: both windows return to the initiating window's monitor, Chats on the left and Workspace on the right, without restarting sessions.
- Fixed Clear terminal scrollback resetting fullscreen chats: it now erases only scrollback without moving the current screen/cursor, re-subscribing or sending native input. Added a scoped contrast bar on existing OpenCode cursors; native cursor hiding remains respected.
- Compacted native Accounts into responsive agent/status/action rows; longer warnings remain in the confirmation dialog. Cursor diagnostics now retains the last focused sample and reports actual cursor shape, colors, outline and box-shadow instead of a misleading pseudo-element border.
- Moved Accounts below Workspace snapshot Git; read-only native status controls show Logged in/Not logged in or unavailable, without saving account output or credentials.
- Enabled workspace-authoring and feature-handoff defaults for OpenCode as well as Codex/Claude. Missing seeded choices inherit defaults; explicit Off and workspace overrides remain intact.
- Added a searchable OpenCode native model catalog with provider labels and verified in-session selection. Native variants are offered automatically after a model change when needed; no terminal restart.
- Added temporary local-only cursor diagnostics for focus, buffer coordinates, cursor visibility, rendering and control-sequence counts. Reports exclude terminal text, authentication and file paths, and are not persisted/exported.

- Added Settings → Accounts for explicit native Codex/Claude and OpenCode/OpenAI login/logout in a separate terminal, never in a model prompt. Short-lived single-use confirmations block active Mr. Mik chats and do not collect credentials/output or enter History/export. Shared-profile effects are explained before launch.
- Fixed OpenCode provider/model errors getting stuck as input requests. Model/Variant reads now inspect only the live viewport, ignore obsolete scrollback menus and allow native readiness checks to recover despite stale local attention. Added a Retry picker action and offline region-error, account confirmation and UI regression coverage.

- Added explicit full-export review for local OpenCode file/tool attachments across session families: exact paths/sizes, default-off single-use approval, expiry and changed-file/chat checks. Approved bytes are embedded in native JSON without editing source chats or linked projects. Remote/private/missing/linked paths and excessive media fail closed. Local-URL versus embedded-URL imports conservatively keep the local branch; no automatic external-file reads or native overwrites on import. Added archive, UI, security and isolated native media round-trip coverage.

- OpenCode full transfer now bundles bounded parent/child conversation families, preserves native parent IDs and updates compatible descendant continuations as a group. Divergence in any member preserves the complete local family. Import previews show the native session count; recursive deletion reviews every member, protects separate History references and verifies removal of every planned ID. Cross-folder/external subagent dependencies, malformed/overlapping families and excessive size/depth fail closed. Added isolated native parent/child/grandchild and UI regression tests.

- Added bounded OpenCode final-answer excerpts to managed History (350 characters), with exact session/message ownership checks, stale-read rejection, persistence and transfer regression coverage. No reasoning/tool-output stream or duplicate transcript is stored.
- Corrected the obsolete New chat transfer notice and documented OpenCode feature coverage, native differences and remaining safety limits in Help.

- Added the first OpenCode 1.x chat adapter: native launch/resume, workspace/card/linked-project associations, managed native-ID and activity observation, and scoped content Bridge orientation.
- Native graceful shutdown protects session persistence; version 2.x is rejected until its different plugin API is adapted and tested.
- Light transfer accepts OpenCode History metadata. Full transfer refuses unsupported native OpenCode data instead of silently losing it.
- Added OpenCode Hub global/workspace skill switches with independent defaults, native linked-project skill creation/permissions, MCP inventory and global/project On/Off/Inherit, plus an owned-definition MCP editor. JSONC comments and unrelated settings are preserved; external MCP definitions remain switchable without destructive editing.
- The Bridge uses the same OpenCode skill/tool adapters with write confirmation. Workspace snapshots preserve OpenCode Hub skill scopes and deduplicate shared canonical skill files. Plugin declarations remain read-only; native credentials/configuration are not exported.
- Added compact OpenCode quick-chat shortcuts, native fork with a distinct captured ID, scoped native Send/Stop, and recognized native Model/Variant pickers without restarting chats. Private invocation-only TUI controls validate the active conversation and fail closed on unknown/stale layouts; they do not intercept credentials or expose a new HTTP port.
- Mik now manages scoped OpenCode worker chats with existing confirmations, exact associations, screen-before-send guards and native readiness/submit/abort. OpenCode variants remain separate from Codex/Claude worker reasoning; the coordinator itself still uses Codex.
- Added managed OpenCode full native JSON transfer through official import/export, verified append-only continuations with backups, destination relinking and controlled native `session delete` with an absence check. Database inspection is read-only. Divergent OpenCode chats cannot be overwritten; task lists remain archive references and existing native metadata is retained. Verified CLI 1.18.34 is required; unsupported family dependencies and unapproved/unsafe attachment references fail closed rather than silently losing data. See `docs/opencode-integration.md` for the precise development status.
- Development packaging supports a validated `MRMIK_RELEASE_SUFFIX`, keeping preview artifacts separate from published releases without changing the internal app version. Release verification now checks bundled OpenCode adapters/plugins and SQLite support in the shipped Node runtime.

### CI portability

- Command-construction tests now use an isolated, never-executed Codex npm fixture instead of relying on a locally installed CLI or account.
- The image attachment terminal test waits for the PowerShell prompt, verifies the exact quoted input without submission, and avoids filename wrapping in long checkout paths.
- These are test-only corrections; published 0.2.7 binaries and its release tag remain unchanged.

## 0.2.7 — Core Hub skill defaults (2026-10-01)

- New source and portable Hubs enable workspace-authoring and feature-handoff for both Codex and Claude; every other Hub skill stays Off. Public starter defaults are separate from saved user scope settings, and existing Hubs are not migrated.
- Added shared compact skill-use guidance to Codex/Claude chat orientation, Bridge instructions and Mik: consult enabled skills only for relevant card content or handoffs, skip disabled skills, reuse loaded instructions and avoid preloading unrelated content.
- Added regression checks for workspace Off/Inherit, explicit global Off, preservation of existing settings and starter distribution defaults. Missing-only runtime skill installation supplies core modules and their authoring workflow without activating them in existing Hubs.

## 0.2.6 — Retained optional skills (2026-10-01)

- Restored fal.ai generation, Higgsfield workflow, motion-reference workflow and local voice-dictation setup for both Codex and Claude. All remain Off by default in Hub/Bridge scope controls; native CLI discovery follows its own rules.
- Installer runtime and portable include all four optional modules and the dictation setup note. Existing customized folders and scope settings are preserved; no tools, accounts, paid jobs or conversational voice are enabled automatically.
- Distribution checks now reject mismatched Codex/Claude skill folder sets and verify the fresh portable's Off defaults. The original demonstration cards remain replaced by the separate Midnight Workshop example.

## 0.2.5 — Card content and actions (2026-10-01)

- Moved card action controls to the right end of the external banner. The menu trigger now uses visible filled dots; Archive/Restore and Delete have distinct icons.
- Moved multi-page navigation into the card content area, separate from external commands. Single-page cards no longer show a redundant page tab. This applies to existing cards and all example cards without rewriting their content.

## 0.2.4 — Mik’s Midnight Workshop (2026-10-01)

- Added an offline, playful example workspace with four sample cards, five themed HTML pages, section navigation, a local editable SVG illustration and image preview/download support.
- New portable packages include the example. Existing Hubs opt in through Workspaces → Add example workspace; repeat additions select the existing example and preserve edits.
- Workspaces can now start without external linked folders. Their card chats use workspace planning; adding the first real linked folder creates no placeholder repository. Native tool configuration still requires an actual linked folder.
- Example identity and Hub-only workspaces survive full/light archive and workspace-snapshot transfer. Example cards remain visible until explicitly archived and can be removed with the standard card/workspace actions.

## 0.2.3 — First beta candidate (2026-10-01)

- Added card action menus on the home grid and card view: Archive, Restore and Delete. Deletion recycles only validated Hub content, with a recovery manifest if Windows does not confirm it; external folders and native chats are never deleted.
- Workspace removal and linked-project unlink now show affected cards and offer Keep (default), Archive or Delete. Retained workspace cards/libraries move to Global Hub; unlink retains cards in their workspace without a working-project association.
- Added the current workspace name to the top breadcrumb, including the actual workspace of an opened card.
- Added open-chat/coordinator guards, reviewed-selection checks and cleanup of saved chat associations without altering native IDs or original working folders.
- Updated fflate to 0.8.3. Service dependency audit reports no known vulnerabilities for the locked dependency graph.
- Updated Help and documentation for card storage, removal, recovery and transfer boundaries. Existing used portable Hubs are not overwritten.

- Documented Kimi's limited, unvalidated terminal integration and distinguished PowerShell from AI chats.

- Added a version-qualified Mr. Mak/Mr. Mik workflow comparison and the app overview to README; moved the mascot to the end. Clean source export now includes overview.png.

- Restored the workspace/chats mascot and native icons to the approved 0.2.1 cap design; the experimental 0.2.2 striped cap is not retained in source.

## 0.2.2 — Striped cap (2026-09-30)

- Further enlarged Mr. Mik's cap with a wider, flatter silhouette and contrasting diagonal fabric stripes visible at small icon sizes.
- Updated both workspace/chats SVGs and native application icons. No behavior or data-format changes.

## 0.2.1 — Optional game skill pack (2026-09-30)

- Added six MIT-licensed upstream game workflows: animation integration, audio, level design, UI, VFX and gameplay visual review. Adapted their Hub/project boundaries to the Workspace Bridge.
- Hub skill controls start all new skills Off for both Codex and Claude. Global enabling and workspace On/Off/Inherit overrides remain independent for each agent.
- Installer and portable runtime add only missing pack folders to the selected Hub at startup; customized skill folders and existing scope settings are never replaced. Native CLI discovery when working directly in the Hub remains distinct from Bridge availability.
- Enlarged the workspace/chats pig icon's cap and added visible seams for legibility at small sizes.
- No chat, archive or workspace snapshot schema change.
- Clean source/portable packaging uses the maintained skill names for both agents, excluding stale Claude-only provider/voice modules without deleting recipient files.

## 0.2.0 — Mr. Mik (2026-09-30)

First independently named release of the customized Mr. Mak fork. Upstream version numbers remain independent; this is not upstream 0.4.15.

### Customized Hub features carried forward

- Logical workspaces, multiple linked project folders, project-associated cards and planning cards; original external folders remain untouched except explicit tool/skill configuration.
- Global/workspace Knowledge and Processes, shared physical Inbox with project metadata, global Context and lazy Bridge discovery.
- Native Codex/Claude chat launching, resume, managed History, archive/restore, controlled removal and native deletion, model/reasoning controls and clipboard associations.
- Hub skill scopes with workspace on/off/inherit overrides; native project skill browsing/creation; global/project MCP controls according to native provider support.
- Persistent Codex-based Mik coordinator with model/reasoning controls, resume/fork and worker coordination; old voice feature disabled.
- Full/light Hub archives, Codex/Claude transcript continuation handling, relinking, optional settings restoration and divergence backups.
- Expanded Help, accent themes and consistent project/card selection controls.

### New in this release

- Mr. Mik name, approved spotted-pig mascot and separate native application identifier. Legacy internal filenames/state/protocol keys remain compatible.
- Source-only clean-copy command, clean starter checks, installer/portable/checksum packaging and manually invoked artifact build workflow.
- Workspace content snapshots with schema/stable IDs, linked-project descriptors, project-effective Hub skills, previewed import/update and backup/rollback. No native chats/auth/configs or external folders in this format.
- Manual upstream adaptations: credential-free runtime diagnostics, `fast-uri` 3.1.8 override, bounded large Codex session metadata, continued first-session discovery, absolute Markdown preview base URLs and report error recovery.
- Single-command root/service dependency installation, upstream ledger and distribution/security documentation.

### Known limitations

- Model/effort controls depend on installed CLI capabilities and native menus; provider/account availability is not guaranteed.
- The coordinator engine is still Codex; no live paid/authenticated Claude model test is bundled.
- Snapshot import is not a three-way Git merge. All conflicting files must be accepted for replacement, or the import is canceled; the full Hub archive retains its separate conflict semantics.
- Files/skills can contain private text even without credential-like filenames. Review exports before sharing.
- The optional upstream game-skill pack is not automatically enabled or substituted for existing skills.
