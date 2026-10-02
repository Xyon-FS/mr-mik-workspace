# Upstream adaptation ledger

Upstream: [witnesstodark/mr-mak-workspace](https://github.com/witnesstodark/mr-mak-workspace). Customized baseline: public 0.1.2. Reviewed upstream releases: [0.4.14](https://github.com/witnesstodark/mr-mak-workspace/releases/tag/v0.4.14) and [0.4.15](https://github.com/witnesstodark/mr-mak-workspace/releases/tag/v0.4.15). Upstream versions are not this fork's versions.

Changes are manually adapted; do not pull/merge upstream application files into this substantially different Hub. Preserve the customized project model, Bridge, Codex/Claude parity, private archive handling and themes.

| Upstream change | Fork treatment | Checks |
| --- | --- | --- |
| Runtime diagnostics without local window auth | PID/origin only; window auth stays on the startup pipe | Runtime source assertion and native smoke test |
| fast-uri dependency correction | Service override 3.1.8, refreshed lockfile | Dependency tree, audit |
| Larger first Codex metadata record | Bounded 2 MiB chunked parse; exact managed identity preserved | Large/BOM/partial records; no guessed unrelated chat |
| Slower/delayed native-session detection | Retry until closed/process replaced; reduce poll frequency after 30 seconds | Session discovery/History tests |
| Relative Markdown links/images in previews | Absolute preview base before resolving relative URLs | Frontend build and preview tests |
| Report error recovery | Boundary around report content, navigation retained | Frontend build, controlled render failure test |
| Root/service dependency setup | Root postinstall runs service ci | Clean installation/build |
| Optional game skill expansion | Six new workflows ported in 0.2.1, initially Off in Hub controls | Codex/Claude parity, missing-only installation, scope/override tests |
| Security documentation | Fork-specific boundaries and export privacy documented | Human review, no claim of resolving every upstream issue |

## Optional skill pack

0.4.14/0.4.15 introduce game-animation-integration, game-audio-workflow, game-level-design, game-ui-workflow, game-vfx-workflow and gameplay-visual-review, plus revisions to production-routing, Blender animation and handoff workflows. These are reasonable optional additions for game workspaces, not mandatory global startup instructions.

Integrated in 0.2.1 from upstream commit `f122637a26c584ae1d3e48470d11874517913748` (v0.4.15), under the upstream MIT license. The six SKILL.md files and VFX implementation reference are retained, with a compact Mr. Mik scope section added to each skill. Existing production-routing, Blender animation and handoff customizations are not replaced.

Canonical files live in .agents/skills, with complete matching copies in .claude/skills. The runtime carries the six additions so installed/portable updates can add missing folders to an existing Hub. Entire existing skill folders are skipped; scope registries are never rewritten by this installation. Absent scope entries mean Off for both agents, with normal global/workspace controls. No optional paid provider is installed or enabled.

These switches control Mr. Mik Bridge discovery/reading. They do not rewrite native Codex/Claude discovery rules when a CLI is launched directly inside the Hub itself.

## Future upstream updates

### 0.4.16 — OpenCode (integration in progress)

The native event-observation approach has been manually adapted, not merged.
Mr. Mik adds its own frozen workspace/card/linked-project scope and content
Bridge orientation without creating native configuration in external folders.
CLI 1.18.34 has passed an isolated localhost-model smoke test, including exact
session identity, actual system-context orientation, Bridge tool discovery and
completion events. A redundant native busy event after the final answer is
handled explicitly. Unrelated OpenCode sessions are not imported by scanning.

Mr. Mik-specific native skill and MCP adapters now add independent Hub skill
switches, linked-folder skill permissions/creation, JSONC-preserving MCP controls
and owned definitions. These were not blindly copied from upstream. Isolated
UI tests and native CLI checks cover the project overrides; workspace snapshots
retain OpenCode skill scopes without exporting native configuration or secrets.

The chat-control stage adds native quick chat/fork, TUI-scoped Send/Stop and
recognized Model/Variant picker mirroring. A Mr. Mik-only TUI plugin uses the
official 1.18.34 plugin contract; no credential interception or extra listener.
Unknown layouts fail closed. Native ConPTY tests use an isolated local mock,
and browser tests cover the new controls and existing Codex/Claude flows.

Mik now manages visible OpenCode workers in its frozen request scope, with real
UI confirmations and native readiness/submit/abort controls. Its engine remains
Codex; OpenCode access and model variants remain separately configured.

Bounded same-folder families and explicitly reviewed local attachments now transfer
through native JSON. This does **not** mark all OpenCode work complete. New CLI versions require real acceptance testing;
unsupported family/media dependencies and real-provider acceptance remain
separate stages; see [development status](opencode-integration.md). The
published 0.2.7 packages are unchanged.

Record upstream tag/commit, relevant files, accepted/rejected changes, compatibility impact and tests here. Adapt fixes one concern at a time. Recheck archive/snapshot compatibility and clean distribution after every data-model/configuration change. Rebuild installer/portable and checksums only after verification. Publishing remains a maintainer action.
