# Platform follow-up audit

Scope: provider accounts and complete-export omissions are fixed in this pass.
Skill catalogs, native transfer coverage and external configuration changes are
analysis only. No live MCP reload, global native Codex skill switch or additional
plugin controls have been added.

## Native skill catalogs

The app does **not** intentionally list only project-local skills. Hub skills are
a separate, scoped Bridge catalog. Native controls discover the following sources:

| Adapter | Native sources currently inspected | Live-session verification |
| --- | --- | --- |
| Codex | Personal `.agents/skills`, legacy Codex-home `skills`, selected project's `.agents/skills`; plugin rows identify bundled skills | No live native skill inventory query. Disk/config discovery is not proof of what an already-open chat loaded. Ancestor/system/other native discovery sources are not exhaustively mirrored. |
| Claude | User/config-dir `skills`, selected project's `.claude/skills`; plugin enablement separately | No live catalog query. Plugin-contained skills are not flattened into individual skill rows. Ancestor/managed-policy sources are not exhaustively mirrored. |
| OpenCode V1 | Personal `.agents`/`.claude`, native config skills, configured local paths, project/ancestor `.agents`/`.claude`/`.opencode` skills until the Git boundary or filesystem root | Local discovery only; downloaded/remote native sources are not fetched by Mik. |
| OpenCode V2 | Personal/project/ancestor directories, singular/plural skill folders, configured local paths, direct Markdown and nested `SKILL.md` | An owned, available V2 chat can add native catalog metadata, including already-loaded remote sources. Otherwise the inventory falls back to local discovery. |

V2 metadata queries are bounded and omit instruction bodies. Native discovery,
enablement, approval and actual model invocation remain different states. A skill
being listed does not guarantee autonomous invocation. Hub skills are read on demand
through the Bridge; their switches do not require a native CLI restart.

Useful future improvement: label every catalog's provenance (local declaration vs
native-observed) and disclose incomplete native sources, rather than calling a disk
inventory the chat's effective catalog. Do not fetch every instruction or remote
source merely to render the menu.

Code: `codex-scopes.mjs`, `claude-settings.mjs`, `opencode-settings.mjs`,
`opencode-v2-skills.mjs`, and the `inspectSkills` callback in `server.mjs`.

## Codex/Claude transfer: descendants and attachments

| Adapter | Included now | Not guaranteed |
| --- | --- | --- |
| Codex | Rollout JSONL for each managed native ID, plus saved coordinator thread IDs; content already embedded in that transcript | Independently stored child-agent rollouts are not traversed automatically. External image/file/tool-output paths are not copied merely because the transcript mentions them. |
| Claude | Main session JSONL, session-ID companion tree (including subagents/tool results when stored there), session-scoped tasks/file-history/uploads/image-cache | Arbitrary referenced external paths and child sessions outside the associated companion/session-ID trees. There is no explicit cross-session family manifest equivalent to OpenCode's guarded topology. |

Existing imports preserve matching IDs and handle continuation/divergence under the
current platform-specific rules. Transferring a main chat is not a promise to make
every historical external path portable. Full-export transcript checks added here
prevent missing main contexts from disappearing silently; they do not invent a
child graph or attachment-copy policy.

Recommendation: first add a review/report of detected external references and
missing descendant data. For Codex, investigate native child-ID relationships with
isolated fixtures before bounded family traversal. Claude already transfers its
ordinary session companion directories; prove any remaining practical gap before
adding a separate graph mechanism. Never copy an entire CLI profile or home folder.

Code: `PortableArchive.exportTo`, Claude companion import helpers in
`portable-archive.mjs`, and `native-events.mjs` transcript lookup.

## Changes made outside Mr. Mik

Current refresh scans run after supported app/Bridge editor writes, and native
launches capture a baseline. The 1.2-second ToolRefresh timer processes **pending
jobs**, not a continuous rescan of every configuration file. Refreshing the Tools
inventory rereads declarations but does not itself enqueue a chat refresh. Manual
apply consumes an existing pending job; it is not an external-change detector.

Example: editing `.codex/config.toml` in another editor can update what the Tools
inventory displays while an existing chat keeps its old native configuration.
Without a supported write-triggered scan or new launch, the change need not produce
a pending update notification.

Cost analysis (structural, not a hardware benchmark): a complete scan currently
rebuilds inventories per open chat and reads/hashes native skill contents, with a
1 MB per-skill safety bound. Polling full scans continuously would multiply filesystem
work with both chat and skill counts, including repeated reads for chats sharing a
working folder. The existing pending-job timer is much cheaper when nothing changes.

Recommended design, if requested later:

1. Deduplicate detection by agent/profile/working-folder, not by chat.
2. Watch or stat known config/catalog paths, with debouncing and a low-frequency
   fallback for missed filesystem events; stat metadata is cheaper than hashing
   every skill body on every tick.
3. Recompute relevant fingerprints only after a candidate change, then compare
   against each affected chat's launch baseline.
4. Reuse idle/empty-prompt safety gates. Never restart an active request or discard
   drafts. Keep manual application available when readiness cannot be proven.
5. Do not poll remote MCP servers or read auth files. Avoid recording raw config
   values; existing private fingerprints need only detect a difference.

No monitor was implemented in this pass. Auxiliary skill assets, remote catalogs
and plugin runtime state would need explicit scope decisions, not blind recursion.

Code: `tool-refresh.mjs`, `native-refresh-snapshot.mjs`, and editor wrappers in
`server.mjs`.

## Provider-account boundary

OpenCode V2 `auth list --format json` reports connected integrations, not every
unconnected provider. Connect provider delegates discovery to the native picker.
Its rows retain only integration ID, fixed status and whether a removable credential
connection exists; native account labels and environment variable names are omitted.
Native integrations may also include MCP authentication, depending on OpenCode.
V1 table display names are never guessed into provider IDs: actions use the native
picker when a reliable identity is unavailable. Environment credentials cannot be
removed by native logout. Presence is not a token/subscription validation.

Primary references: [OpenCode V2 CLI commands](https://opencode.ai/v2/docs/cli/commands/),
[V2 native auth-list implementation](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/cli/src/commands/handlers/auth/list.ts),
[V2 native logout implementation](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/cli/src/commands/handlers/auth/logout.ts).
