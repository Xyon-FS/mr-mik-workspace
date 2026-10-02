# MCP updates in open chats

Mik distinguishes configuration on disk from connections in a running chat.
Changes made through Tools, MCP definition editors, the Workspace Bridge or Mik's
coordinator use the same update scheduler. This is not a watcher for arbitrary
external file edits: close/reopen the chat after editing configuration elsewhere.

## Which chats change?

The scheduler compares the chat's launch configuration with the current effective
MCP configuration, using its agent and actual working folder. It compares enabled
definitions, not only the top-level global switch. Project overrides remain
authoritative: changing global OpenCode Unity MCP does not restart Codex/Claude
or a folder whose explicit local override keeps its effective configuration
unchanged. Reverting a pending change cancels the unnecessary update.

Private fingerprints exist in service memory only. No MCP definitions, headers,
tokens or draft contents are placed in chat metadata or transfer archives.

## Automatic and manual application

- Idle chats with a verified empty native prompt and no active picker can update
  automatically. Recent typing is protected. Unrecognised prompt layouts do not
  authorize a restart.
- A running task, permission question, draft, shell-mode prompt or native menu
  leaves a pending update. Finish the task, clear/send the draft, close the menu,
  then use the small refresh action above the terminal. The manual action repeats
  the safety checks; it never forcibly interrupts a task or discards a draft.
- A new chat without a captured native conversation ID is not restarted. Send
  its first real message or recover its ID before applying a restart-based update.
- Failures leave an explicit status and require manual review; no restart loop.

OpenCode's existing MCP On/Off controls use native connect/disconnect when the
TUI contract is available and the definition itself has not changed. Mik checks
the native connection status before reporting success. The same terminal and
conversation stay open. Additions or changed definitions use the resume fallback.

Codex and Claude currently use a guarded CLI restart and resume of the same
native conversation, not a new conversation or fork. Mik checks the transcript,
working scope and launch configuration before stopping the old process. The
workspace, linked project, card, permissions and saved reasoning are retained.
A successful resume means the CLI was launched with current configuration;
project trust, approvals, server availability and authentication still determine
whether its tools actually connect. Inspect native MCP status after a failure.

No restart sends a new user prompt, task or replayed chat transcript. Compact
Hub orientation is supplied once per process as system/developer context, not
accumulated as repeated user messages. It participates in later model requests.

## Skills, plugins and transfers

Hub skills accessed through the Bridge already recheck current availability on
each list/read. Disabling a skill blocks further Bridge reads, but cannot erase
instructions the model has already read. Native skill reload/synchronization is
not part of this stage. A plugin toggle is detected here only insofar as it changes
its declared MCP servers; other plugin capabilities are not certified by this
scheduler.

Pending flags, private fingerprints and native-control receipts are local runtime
state, not transferable chat context. Export excludes this update status and
import rebuilds launch baselines from the destination machine's configuration.
Normal full/light chat transfer and conflict handling are unchanged.

## Verification

Use a disposable chat and a harmless MCP. Test an idle On/Off change, a change
during a task, an unsent draft, a native model dialog, a locally overridden global
change, a changed definition and a failed connection. The conversation ID must
remain unchanged across a resume; unrelated agents/folders must not restart.
Native OpenCode checks use an isolated profile and localhost fixtures, not a paid
provider. Codex/Claude authenticated native readiness still needs user validation.
