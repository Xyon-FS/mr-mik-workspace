# Optional game skill pack

Source: witnesstodark/mr-mak-workspace, v0.4.15, commit
`f122637a26c584ae1d3e48470d11874517913748`, upstream MIT license.

| Skill | Purpose |
| --- | --- |
| game-animation-integration | Integrate approved clips, locomotion phases and authoritative animation events |
| game-audio-workflow | Event-driven sound banks, repetition limits, mixer lifecycle and native listening checks |
| game-level-design | Spatial plans, approved scene changes, navigation and coordinate contracts |
| game-ui-workflow | HUD/menu design, reusable engine assets and gameplay input checks |
| game-vfx-workflow | Layer contracts, event timing, cleanup, readability and native performance evidence |
| gameplay-visual-review | Controlled native captures and behavior checks with clearly labeled evidence |

All six are initially Off in Mr. Mik's Hub controls, independently for Codex and
Claude. Missing scope entries are Off; no personal scope file is bundled.
Global On shares a workflow across workspaces. Workspace On/Off overrides that
choice; Inherit restores it. Native linked-project skill files are distinct.

The maintained copies live in .agents/skills and are synchronized to
.claude/skills, including the VFX implementation reference. The runtime carries
the pack so updates can add missing folders to existing Hubs. Existing folders
and settings are never overwritten by pack installation.

Clean source and portable packaging mirror only the canonical maintained names.
Stale or recipient-added Claude-only modules are not silently shipped as part
of this pack; their original source folders are not deleted.

The added scope paragraph routes Hub content through the Workspace Bridge and
keeps engine/source changes in the selected linked project. Full skill contents
are consulted only when relevant, not injected as startup context. No provider,
MCP server or paid workflow is automatically activated. Existing customized
production-routing, Blender animation and handoff workflows are unchanged.

Hub switches govern Bridge discovery/read access, not native Codex skill
discovery for a CLI launched directly inside the Hub root.
