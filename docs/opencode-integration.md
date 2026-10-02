# OpenCode integration — support and limits

OpenCode V1/V2 adapters are included in the 0.2.8 packages, with the native differences and safety limits documented below. This is not a claim of identical Codex/Claude capabilities. Older packages do not update themselves.

## Chats and scope

- OpenCode appears in New chat when its CLI is installed. Select the workspace,
  optional card and working linked project as for the other clients. A linked
  project need not be a Git repository.
- CLI version is diagnostic, not an allowlist. Later minor and major versions
  may launch; compatibility depends on native commands, plugin contracts and data.
  Unavailable native controls fail individually and leave the terminal available.
- OpenCode owns provider authentication, model selection and native sessions.
  Mr. Mik does not reuse Codex/Claude credentials or subscriptions.
- An invocation-only local plugin records the native session ID and activity
  for this Mr. Mik chat. It neither searches unrelated OpenCode conversations
  nor saves prompts or credentials in its observation file. History additionally
  keeps at most 350 characters of the final assistant answer, read through the
  invocation's native client for that exact session/message only. Reasoning and
  tool outputs are excluded; no model call or second transcript is created.
- History keeps the workspace, card and linked project association, saved
  terminal screen and native ID. Resume uses that ID. Empty chats are not kept.
  Final-answer excerpts persist with History and travel in light/full archives.
  A failed native read leaves the excerpt unavailable; stale reads are discarded
  and a late excerpt does not repeat completion/unread notifications. Existing
  conversations are not scanned or backfilled merely by opening History.
- Scoped Workspace Bridge and compact orientation distinguish the linked
  working folder from Hub cards, Knowledge, Processes and Inbox. The plugin
  adds orientation to the system context on demand; Hub contents are not
  preloaded. Its system-context hook is experimental in OpenCode.
- Closing a tab requests graceful native shutdown before a bounded kill.
- Light export preserves History references and saved screens, not native
  OpenCode data. Full transfer is implemented with the guarded limits described
  in the fifth stage below.

Runtime files are private under `.mrmak/opencode`; the plugin is loaded from the
application runtime. No `.opencode`, `.codex` or `.claude` configuration is
created in a linked project merely by opening a chat.

## Skills and Tools

- **Skills → OpenCode → Hub** uses the canonical `.agents/skills` files, shared
  with Codex, but separate `opencodeSkills` availability settings. Missing
  OpenCode settings inherit its own defaults: workspace-authoring and feature-handoff On, other workflows Off. Explicit choices are preserved. Global On/Off and workspace
  Inherit/On/Off control Bridge discovery without copying skills into projects.
- **Skills → OpenCode → Linked project** browses `.opencode/skills` in the chosen
  folder. **+** creates the missing directories and a native `SKILL.md` without
  replacing existing files. Native controls also inspect compatible `.agents`
  and `.claude` skill locations and ancestor/global skills; permissions are
  changed by name through `permission.skill`, not by rewriting instructions.
- **Tools → OpenCode** inventories native MCP definitions in the global
  OpenCode config directory and the selected linked folder's JSON/JSONC config.
  Global On/Off and project Inherit/On/Off also work for definitions created
  outside Mr. Mik. Project overrides can disable a globally enabled MCP without
  duplicating its installation. V2 replacement-style overrides must retain safe transport/options or references; sensitive literal credentials require explicit configuration.
- **+ Add MCP server → OpenCode** writes a local-process or remote definition
  globally or in the selected linked folder. Replacement/removal is restricted
  to unchanged Mr. Mik-owned definitions; external definitions remain switchable.
  This configures servers, not their software installation or authentication.
- JSONC comments and unrelated settings are preserved. Configuration backups
  stay private in `.mrmak/opencode-config-backups`; neither credentials nor
  command arguments are returned by the editor inventory. Custom runtime
  config environment variables make controls read-only rather than pretending
  an override is effective.
- V1 plugin declarations are read-only; V2 offers exact-ID exclusions for verified native server plugins. A declaration is not proof of
  installation. OpenCode 1.x does not offer the same per-plugin `enabled` switch
  as MCP servers. Native plugin provisioning is not implemented here.
- Bridge skill/tool actions call these same adapters and require explicit
  confirmation for writes. They never route OpenCode settings to Codex/Claude.
- Workspace snapshots preserve OpenCode Hub skill files and effective workspace
  settings. Shared Codex/OpenCode files are deduplicated on import; contradictory
  copies are rejected. Snapshots and light archives do not transfer native MCP
  configuration, ownership backups, account state or native conversations.

Controls describe files, not a running connection. Agent-level permissions,
ancestor, remote or managed configuration can further restrict availability.
MCP changes made through Mik update affected open chats when safe; native skill/plugin changes use protected same-conversation resume. External edits are not watched. Inside the Hub itself native OpenCode discovery
of `.agents/skills` is distinct from the Bridge scope switches.

## Chat controls

- The compact OpenCode + shortcut opens a card's linked working folder, or Hub
  planning when no linked folder is assigned, preserving workspace/card scope.
- Fork launches native `--session <source> --fork` in a separate tab. Its fresh
  native ID is observed independently; the source chat is neither restarted nor
  overwritten. CLI 1.18.34 forks are root sessions, not subagent children.
- The existing Send/Stop icon now dispatches native prompt submission or abort
  for this exact conversation. Dialogs and native permission/questions are not
  approved or answered by the control. Stop does not undo file changes.
- Model lists the connected native catalog with search and provider labels. Opening
  this list does not open a terminal dialog. Selection opens the native model
  dialog, searches there and verifies the exact provider/model before confirming,
  without restarting the terminal. Ambiguous identities fail closed.
  **Variant** mirrors the actual native variant menu; names are not Codex levels.
  When model selection opens a variant dialog, Mr. Mik offers its options automatically.
  No variant menu and an unreadable model menu have distinct fallback messages.
- An invocation-only TUI plugin receives bounded, expiring local file requests.
  No new HTTP listener, prompt log or authentication bridge is added. It checks
  the active native route against the managed conversation before dispatching.
  Receipts and temporary TUI config live privately in `.mrmak/opencode` and are
  not exported; they are regenerated at launch. Native model preferences remain
  OpenCode-managed, not new Mr. Mik settings.
- Stale menus, ambiguous rows, changed processes or unknown layouts fail closed:
  no unverified Enter is sent. The terminal remains usable. An explicit existing
  `OPENCODE_TUI_CONFIG` is preserved, not relocated; Mr. Mik TUI controls are
  unavailable in that case unless the user supplies the adapter separately.

`node desktop/service/test/opencode-chat-native.mjs` verifies real ConPTY model
and variant selection, submission, abort and distinct fork identity with CLI
1.18.34 and an isolated localhost mock. Older 1.x TUI plugin APIs/layouts may
not support these controls and fall back to the terminal. No real provider
acceptance, account access or paid calls are covered by this test.

## Mik workers

Mik can open OpenCode workers in the frozen workspace/card/linked-folder scope,
read their screens, send approved tasks, attach paths, interrupt the response,
close/resume tabs, and rename/pin managed History. Existing workspace boundaries,
real UI confirmations and screen-before-send checks remain in force.

Before pasting, the invocation-only adapter verifies native readiness, exact
conversation route, idle status and absence of dialogs/permissions/questions.
It rechecks before native submission. If submission fails after pasting, the
draft is left for manual review, with no automatic retry. Interruption dispatches
native abort instead of Ctrl+C, keeping the worker open. Unavailable controls
fail closed; they never fall back to generic Enter/Ctrl+C.

Mik's engine/model/reasoning remains Codex. OpenCode uses its own separately
configured provider and native model/variant controls; an OpenCode worker rejects
Codex-style effort overrides. Agent installation is not proof of provider access.
No provider login, software installation or permanent native deletion is added
to coordinator tools. Configuration writes retain Bridge confirmations.

## Native transfer and deletion

Full Hub archives include official OpenCode JSON exports for exact native IDs
referenced by managed History, including their native child sessions, supplemented
by per-session task-list reference snapshots. An unrelated native session is not
discovered or added to History.
Light archives remain metadata/screens only. Full transfer lists unavailable contexts for explicit exclusion; healthy conversations still transfer. Unsafe manifests/paths, present-file checksum failures and ownership collisions remain blocking.
No database, account state, authentication, global configuration, runtime plugin
or whole OpenCode home is copied. Session-specific permission overrides and share
links are excluded. Conversation text itself can still be sensitive.

Preview compares stable message/part IDs and exact content, excluding destination
folder/project binding. An exact message-prefix extension is an update; a shorter
prefix preserves the local continuation. Divergence is skipped; an OpenCode
replacement choice is rejected before Hub changes. Timestamps alone never establish a continuation. Existing native
JSON is backed up under `.mrmak/import-backups/.../native/opencode` before an
update, alongside normal History/screen backups. Reimport deduplicates
native and managed IDs, and accepted imports update the managed History/screen.

The official `opencode import` registers the destination linked folder/project
and inserts missing messages/parts. Existing IDs are not replaced. Native export
after import must match the expected conversation and destination folder.
SQLite connections are strictly read-only, used for identity, child-session,
revision and collision inspection, never for session mutations. IDs owned by
another conversation, changed native state and unrecognized schemas are rejected.
The adapter does not pin a CLI release. Required database columns, native JSON,
identity/topology and isolated import round-trips determine compatibility. Extra
columns/tables are allowed; incompatible structures stop transfer/deletion before
mutation. CLI **1.18.34** is the tested baseline, not an installation requirement.
Native commands use a disposable account/configuration context pointed only at
the selected session database, preventing OpenCode's automatic config-schema
updates. The official importer validates all native message/part schemas in an
additional disposable database before any destination import.

The archived task list is a reference snapshot only: native import does not
restore it. Existing native session metadata (title, model, token accounting and
timestamps) remains under OpenCode's control; it is not a complete home/state
restore. Conflict classification compares message content and revert state rather
than those bookkeeping fields. Freshness checks still include native metadata.
CLI import is not a Mr. Mik transaction: concurrent writers or an interrupted
native command may leave partial changes. Close other OpenCode instances first;
on failed verification keep the backup and stop, never apply a guessed SQL rollback.

History's **Delete native chat…** uses the existing styled confirmation, exact
chat-name entry, a short-lived plan and a fresh content check. Close the chat first;
duplicate Mr. Mik references block deletion. This main session and all listed
descendants are deleted using `opencode session delete`, then every planned ID's absence is checked
before forgetting History. External files, other chats, accounts and configuration stay.
SQLite may retain freed pages/WAL bytes: this is logical deletion, not secure
erasure or database compaction. Import backups remain until removed separately.

### Conversation families

The main session is the transfer/deletion unit. Its native descendants are stored
as a flat `children` array in that root's archive JSON, preserving `parentID` and
all native session/message/part IDs. Old standalone envelopes remain supported;
older adapters reject the new envelope instead of silently dropping children.
Import uses separate official per-session JSON files, parents first, after the
entire family has passed isolated native validation. It verifies the complete
result and relinks every member to the selected root chat's working folder.
Use Mr. Mik to import this archive envelope: passing it directly to OpenCode's
single-session importer would ignore the additional children and task snapshots.

Preview compares all members. New children and append-only descendant turns can
update the family; extra/longer local children keep the local family. A divergent
member, changed parent relationship or mixed incoming/local continuations makes
the entire family a conflict, without partial merging. Reimport keeps one main
History entry, not additional subagent tabs. Native forks are independent roots,
not child sessions; task references to sessions outside the family are refused.

All members must use the same working folder. A child with its own Mr. Mik
History association blocks full transfer/deletion until that separate association
is removed. Overlapping families, foreign session/message/part identities,
missing parents, cycles and nested envelopes are rejected. The bounds are 64
sessions, depth 16 and 64 MB combined JSON. Child permission/share/workspace
overrides are stripped too. Task lists are not rehydrated and running jobs are
not restarted on import; this remains conversation transfer, not runtime recovery.

The delete confirmation lists every title and native ID. A descendant created or
changed since the plan requires a new confirmation. Close every other OpenCode
instance using the family: the check-to-native-command window cannot lock other
clients, and native deletion can recursively remove newly added children. An
interrupted native deletion may remove part of the family; History is retained
when any planned member remains, but already-deleted records cannot be rolled back.

**Local attachments:** full export reviews referenced file parts and tool-result
attachments across the complete family. Settings shows the exact local paths and
sizes; copying is off until you select **Include all listed files** and confirm.
Review inspects metadata only. Consent is single-use, expires after five minutes,
and is invalidated by changed History, conversation data or file identity. Bytes
are embedded as native data URLs in the archive, not written into linked projects;
source files and native chats remain unchanged. Already embedded media needs no
extra filesystem read. The limit is 128 unique local files, 16 MB each, 32 MB total,
and 64 MB per serialized family. Remote URLs, missing files, directories,
symlinks/junctions, network shares and recognized credential locations are refused.
Review the archive before sharing: filename checks cannot recognize every secret.
Cancel leaves no archive; light export remains available if a reference is unsupported.

**Conservative comparison:** converting a local file URL into a data URL changes
its native message. Reimport into the original profile can therefore be classified
as divergent and keep local, even when only the attachment representation differs.
Mr. Mik does not read external files automatically on import to guess equivalence,
nor overwrite existing native parts. Between profiles using the same embedded
representation, unchanged prefixes continue to update normally. These are native
storage/round-trip checks, not proof that every provider can consume every media type.

**Guarded limits:** unsupported family dependencies still fail closed.
Use light transfer or manage these cases natively. External repositories, Git
snapshot/undo storage, caches and unrelated tool-created files are not copied.
Close OpenCode sessions in other applications too before transferring;
checks detect concurrent changes but do not stop those applications.

`node desktop/service/test/opencode-transfer-native.mjs` verifies import, exact
continuation, divergence refusal, stale-state rejection and native selective deletion
in two isolated native profiles with no provider/account calls. Unit/archive tests
verify managed-only inclusion, History relocation, deduplication, conflict choices,
backups and deletion confirmations. Real provider resume remains a separate check.

`node desktop/service/test/opencode-family-native.mjs` verifies main/child/
grandchild import, native parent links, destination relinking, child-only
continuation, divergent-child refusal and recursive deletion in two isolated
profiles. Read-only SQL, preservation of unrelated conversations/configuration
and the styled family confirmation are covered by native and UI tests.

## Acceptance and remaining limits

The user reports successful Bridge content and Hub skill checks with an
authenticated provider, and a successful MCP check after opening a fresh chat. Broader provider-specific restart/resume and cross-environment
continuation acceptance remain separate checks. These reports do not validate all
models or newer CLI versions.

1. Real provider acceptance and final release validation. Cross-folder families,
   default Model/Variant preferences and
   real acceptance on newer CLI versions remain separate validation work.

Distributable packages use plain incremented versions, without preview suffixes. Use `npm run release:package` and `npm run release:verify` after bumping the app version consistently. Keep the Windows application identity stable for normal updates. Existing release folders are never overwritten; verify packages before publishing. Use a separate portable Hub for acceptance tests.

### Final real-provider acceptance checklist

Use a clean preview portable Hub and a disposable linked folder, not an active
development project. Configure provider authentication in OpenCode itself; never
copy credentials into the Hub, an archive or a bug report. Real prompts consume
the selected provider's allowance and need the user's approval.

1. Open an OpenCode card chat. Ask which workspace/card it is scoped to; verify
   the names match the UI. Ask it to create a small HTML page in that card through
   the Bridge, and confirm that no HTML appears in the external linked folder.
2. Enable one Hub skill for the test workspace, verify relevant discovery, then
   disable it and verify exclusion in a new chat. Test a harmless local MCP and
   its project Off override; do not mistake inventory status for a live connection.
3. Select an available Model/Variant and send a short request. Test Stop during
   an active response and Fork after a completed turn; confirm independent IDs.
   Unknown native picker layouts must leave manual terminal control available.
4. Close and reopen the app, resume the managed conversation and ask a question
   referring to its earlier response. Confirm that History has not duplicated it.
5. Export a full archive. Import into a second disposable Hub/profile, explicitly
   relink its working folder, resume, and verify a later continuation updates on
   reimport. A divergent continuation must keep the local native chat and screen,
   without presenting an OpenCode replacement checkbox.
6. Ask Mik to open and send a short task to an OpenCode worker, approving the UI
   confirmation. Verify the right card/folder, screen reading and worker Stop.
7. Delete only a sacrificial, closed standalone native chat with exact-name
   confirmation. Check that an unrelated test chat still resumes normally.

Start with a standalone acceptance fixture, then test a small same-folder family.
Review a small local attachment separately; verify its self-contained import and
the refusal of unapproved, private or unsupported references. Do not infer support for guarded cases
from a successful ordinary-chat transfer.

Tests must use isolated OpenCode config/data/cache directories and no personal
provider credentials. Paid calls and compatibility with every model are not
covered by offline tests. Real provider acceptance remains a separate check.

The explicit `node desktop/service/test/opencode-native.mjs` smoke test was
passed with CLI **1.18.34**: exact native ID, empty-chat state, connected Bridge,
Hub orientation and Bridge tool schemas in an actual native model request,
and final-turn observation. The provider is a fake localhost server; no real
account or paid model is involved. It also verifies a native MCP project override
and a native skill permission using the real CLI. An isolated browser UI smoke
test verifies Hub override/Inherit, native skill Off, MCP Off and MCP creation.
Generic regression tests do not require an
OpenCode installation. Isolated native UI, same-ID resume and fork acceptance are recorded in release-verification.md. Acceptance with your real provider and a clean destination PC remains a separate check.

## Sources and attribution

### V2 transfer acceptance

The V2 adapter uses native `session export/import/delete --standalone`, not V1 SQL mutation or message conversion. Settled typed histories and bounded same-folder parent/child families transfer to a separate database and relink to the destination folder. Exact duplicates are skipped. Exact-prefix continuations can replace an older local family only after incoming and rollback validation, a verified recovery backup and a fresh ownership/content check. Destination permissions are preserved. Divergent histories remain conflicts; newer local histories are retained. Replacement failures restore the original family; uncertain recovery keeps its backup and Mik lock for manual recovery. Native commands use disposable config/auth profiles and the explicitly selected database. Close all clients using the affected sessions: Mik's lock cannot lock another application.

Families are limited to 64 sessions, depth 16 and a 64 MB serialized envelope. Missing parents, cross-folder children, foreign task references, queued/unsettled work and revert dependencies remain guarded. Independent forks transfer copied history, stable IDs and `mrMikFork` provenance as autonomous conversations; native import does not recreate their original fork-boundary links or every operational snapshot/instruction state. Historical prompt-media bytes are preserved inline. External tool files require explicit export review and safe-path/size checks. Family deletion lists all descendants, protects separately associated History entries and verifies removal without deleting independent forks or external files. These are structural guards, not version pins.

The isolated `opencode-v2-native.mjs` fixture verifies skill IDs, MCP connection, native attention, cross-database transfer, attachments, continuation replacement, injected rollback/partial-import cleanup and recursive deletion. Add `--tui` for native picker, submit/interrupt, provider-error recovery, same-ID resume and fork checks; add `--attention-stress` for twelve consecutive form/reply cycles. All use private profiles and localhost providers, not user accounts or paid calls. Archive/UI tests cover format discrimination, unmanaged-chat exclusion, scopes, deduplication, conflicts and the App/MyHub boundary. Clean-PC and authenticated provider acceptance remain separate from these checks.

Primary contracts: [native V2 transfer implementation](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/core/src/session/transfer.ts) and [native import command](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/cli/src/commands/handlers/session/import.ts).

Native activity observation is adapted from witnesstodark's MIT-licensed
[Mr. Mak Workspace v0.4.16](https://github.com/witnesstodark/mr-mak-workspace/releases/tag/v0.4.16).
See also the official [OpenCode plugin documentation](https://opencode.ai/docs/plugins/)
and [V1 to V2 migration notes](https://opencode.ai/v2/docs/build/plugins/migrate-v1/).
