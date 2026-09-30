# Workspaces, linked projects and shared libraries

Mr. Mik is an organizational hub, not a parent repository for linked projects.
Use **Workspaces → Add workspace** to create a named container and choose its
first external project folder. Add more folders under **Linked projects**. Git is
optional. A linked folder is not copied, moved, automatically trusted, or
configured by registration.

The UI uses four distinct names: **Hub global** for shared content, **Workspace**
for a logical project such as a game, **Linked project** for an external working
folder such as Unity or Blender, and **Card** for an activity or report collection.
Several cards can use one linked project; a card can also be workspace-wide.

Each workspace has one view with multiple associated cards. The hub view
retains all existing cards, including unassigned cards. **New Codex Chat** in a
card opens a chat immediately: it uses the card's linked project as the working
folder, or the workspace planning area when no folder is linked. From the
workspace home it starts a planning chat without assuming the first linked
project. The shortcut uses saved chat defaults; New chat in the Chats panel
still offers manual configuration. Existing chats retain their original working
directory and native conversation ID. History associations are explicit and only
accepted for the same folder; relinking a project never redirects an old chat.

In **Tools**, the *Linked projects* filter uses the selected workspace's external
folders, not another workspace picker. A native MCP or plugin override applies to
the selected working folder; cards without a linked folder do not get a separate
native configuration layer.

The **Skills** `+` offers two explicit destinations. A Hub skill is saved under
Mr. Mik's `.agents/skills` or `.claude/skills` and enabled globally or for one
workspace. A linked-project skill is saved in that external folder; Mr. Mik
creates the missing skill directories only after this destination is selected.
The form creates a new `SKILL.md` without overwriting an existing one. Native
skills are discovered by the agent when a new chat starts. Cards can be pinned
from their own view; pinned cards appear in the Pinned section.

## Storage and scopes

- `projects/registry.json`: portable project identity and descriptive metadata.
- `.mrmak/project-locations.json`: local folder mappings, excluded from Git.
- `workspace/workspace.json`: existing cards plus optional resource metadata.
- `.mrmak/inbox.json`: local Inbox associations, excluded from Git.

Context remains hub/user-level. Technical working rules remain in each project's
`AGENTS.md`; Mr. Mik does not copy or merge them. Knowledge and Processes without
metadata remain global. A resource's optional `projectId` determines its scope.
Inbox files remain physically shared and are unassigned until explicitly linked.

Use the library scope filter for Global, Global + active project, Project only,
or All. Selecting a project changes visible metadata, not a running chat's folder
and not the agent's prompt. Documents are consulted on demand. Processes are
procedures, never scheduled jobs or automatically executed instructions.

Organizational notes belong in the hub. Use **Knowledge → Link technical
documentation** for repository-relative Markdown documents such as
`docs/architecture.md`. The original remains in the external repository.
Missing files or locations are reported, not silently copied or reassigned.

Removing registration never deletes repositories, cards, resources, or native
conversations. Retained associations are shown as unlinked, not made global.

## Scoped Workspace Bridge

New/resumed registered Codex and Claude project chats receive an invocation-only
MCP Bridge. Neither the global nor the linked project's configuration is edited
just to attach the Bridge. The hub is **not** added with `--add-dir`.

The Bridge can list/read project cards, explicitly create a card, add a Markdown
note, change status/pin, search global + project Knowledge/Processes, and read a
selected resource. It can link an existing, non-private repository file to a
project card without moving it. It has no arbitrary filesystem, shell, configuration, Inbox,
Context, or other-project endpoint. Procedures are returned as reference text.
Access capabilities are per chat, never persisted in session metadata, and are
revoked on terminal exit, reassociation, relaunch, or service shutdown.

The Bridge limits its own operations; it does not replace the CLI sandbox or
Windows permissions. Permission bypass still grants the CLI broad native access
and should be chosen deliberately.

## Project tooling

The **Tools** panel reads declared personal/project MCP and plugin settings.
It can write explicit plugin and MCP enablement overrides in the selected
project folder's `.codex/config.toml`. Standalone Codex skill controls live in
**Skills**, not Tools. Mr. Mik owns only
a marked section at the end of that file; it preserves other settings and
refuses to edit a setting already maintained outside its section. No plugin,
skill, or server is installed or copied by these toggles. The global Codex
configuration is changed only when the user selects and confirms a global action.

**Check resolved Codex config** starts a separate, short-lived Codex process
to read the merged settings for a project. The result contains only component
names and enablement, not MCP headers or environment values. It does not prove
that an already-running chat loaded or connected any tool.

The separate **Tools → Add MCP server** form creates and manages
HTTP or stdio definitions in either the selected project's config or the
personal/global Codex config. Global changes require explicit confirmation.
Only definitions created in Mr. Mik's own marked section are editable or
removable there; existing manual entries and plugin-provided servers keep their
source of truth. The form does not manage authentication headers or secrets:
configure those in Codex directly. Changes apply to newly launched chats.

These controls have different semantics:

- Local-marketplace plugins can be enabled for a trusted repository even when
  disabled in personal config. Their bundled skills and MCP follow plugin
  policy. Host/workspace-managed plugins cannot reliably be scoped here and
  are shown read-only.
- Standalone skills in `.agents/skills` are discovered by folder. Personal
  skills are discovered across repositories. `[[skills.config]]` can override
  a particular skill path; it does not move or duplicate the skill. Bundled
  plugin skills are not independently edited as standalone skills. The selected
  folder's native Codex skill overrides appear under **Skills**.
- MCP `enabled` overrides the named personal/project server. The server's
  command, address and credentials are not copied into the project or shown
  in the panel. A named server without a definition is not installed by an
  enablement override. The Workspace Bridge remains invocation-only.

If a component is enabled globally, enabling it in one project does **not**
remove it from other projects. For opt-in-only behavior, disable its global
default explicitly, then enable it in selected trusted project folders.
Mr. Mik never silently alters other projects. Project config is ignored until Codex
trusts the folder. Already-running chats require a new launch to pick up
changed settings. UI inventory is declared state, not proof that a particular
chat loaded the plugin, skill or MCP; verify the new chat using Codex's native
`/skills`, `/mcp` and `/debug-config` commands.

Claude and Kimi retain native chats. Claude Code reads shared project `.mcp.json`
natively, subject to its project-server approval flow; HTTP entries require an
explicit `"type": "http"`. Mr. Mik can also create private project-local Claude
MCP definitions in the matching project entry of `~/.claude.json`. The editor
only manages definitions it created, and never displays account credentials.
Kimi Code discovers global `~/.kimi-code/mcp.json` (or
`KIMI_CODE_HOME/mcp.json`) and project `<project>/.kimi-code/mcp.json` natively;
Mr. Mik does not pass extra MCP launch arguments.
The installed Claude and Kimi CLI versions must be checked before relying on
agent-specific controls; Mr. Mik does not install either CLI.

Each chat has one working repository and can optionally be associated with a
card. The Bridge exposes that selection through `mrmak_chat_context`. It can
list linked repositories and read small non-private text files from them, but
does not grant write access to another repository. HTML pages can be added to
or updated within the matching Hub card; an update requires the exact page
path already registered on the card.

At chat launch Mr. Mik adds a compact destination rule without placing files or
instructions in the linked project. The agent must route Hub objects through
the scoped Bridge and technical project files through its working directory;
ambiguous destinations need clarification. The chat header displays these as
separate Hub and Work in scopes. This improves tool selection but does not make
free-form model decisions deterministic, so tests verify actual destinations.

In the Skills rail, choose Codex or Claude, then **Hub** or **Linked project**.
The folder browser follows this choice instead of showing both locations at
once. Hub uses Mr. Mik's `.agents/skills` for Codex and `.claude/skills` for
Claude; its list distinguishes skills enabled for every workspace from skills
enabled only for the selected workspace. Each agent has separate switches in
`projects/skill-scopes.json`. In a workspace, **Inherit** follows the Hub
default, while **On** and **Off** explicitly override it only there. Existing
workspace selections remain valid; a missing selection means Inherit. The
Bridge advertises short descriptions for
enabled skills at chat startup and provides full instructions only through
`mrmak_read_hub_skill` when relevant. This improves autonomous discovery, but
the agent's decision to consult a skill is not guaranteed. These are Bridge
skills, not native slash-menu skills in linked project folders. Linked project
shows the selected external folder's native skills; when a workspace has
multiple linked projects, choose the folder explicitly. Codex's native skill
controls appear only in this view. Native skill availability is decided by the
CLI when a new chat starts; Claude currently has no equivalent controls here.

Full workspace export includes both Hub skill folders and their scope settings;
light and full exports both carry Hub files, while the chat mode controls native
transcripts. Imports preserve the archive's scope settings, subject to the
selected conflict policy. Linked external project folders are never copied.

The Project page shows recent project chats and can reopen them, link existing
repository artifacts to cards, and open the registered folder in a detected
VS Code or Cursor installation. Open IDE launches only after the user clicks.
