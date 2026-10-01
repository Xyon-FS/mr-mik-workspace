# Changelog

## Unreleased — CI portability

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
