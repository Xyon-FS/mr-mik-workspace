# Mr. Mik Workspace · Manual and reference

Mr. Mik is a local organizational Hub around real folders and real agent CLIs. It keeps cards, reports, libraries and chat history together without copying your linked Unity, Blender, audio or other project folders into the Hub. The two windows are **Workspace** (cards and the right-hand rail) and **Chats** (terminals and History). This document combines a first-use manual, feature reference, storage model and troubleshooting guide. It is available offline from **Help**. A configured integration is not automatically a connected integration in an existing chat.

## Start here

This fork is named **Mr. Mik**, independently maintained from **Mr. Mak by witnesstodark**. It preserves the original license. Windows app settings are separate, while existing Hub folders (including their `.mrmak` state) remain supported. Choose the old Hub explicitly, or import its full private archive into a clean Hub; do not open the same Hub in both apps simultaneously.

### Workspace snapshots for Git

Settings now includes **Workspace snapshot · Git**, separate from **Transfer Hub**. Select a workspace, export a new folder, update an existing validated snapshot with a preview/backup, or import a snapshot with conflict confirmation and optional linked-folder relinking. This format includes workspace cards/files/libraries/associated Inbox and effective Hub skills. It does **not** include chats, global Context, native tool definitions/auth/configuration or linked project contents. Git commits/pushes remain your choice outside the app. Shared styles/skill replacement can affect other workspaces; the import explicitly identifies file conflicts. See [workspace snapshot details](workspace-snapshots.md) for the manifest, backup, update and unresolved-link rules. For full conversation transfer continue to use **Transfer Hub → Export full**.

Before opening a chat, distinguish the **Hub folder** you launched from the **workspaces inside it**. The Hub is the installed app's selected content folder and must contain `workspace/workspace.json`. A workspace is a logical endeavor you create in the app. Its linked projects are external working folders; they do not need to be Git repositories. The desktop app does not include Codex, Claude, OpenCode, their accounts or your project folders.

1. Run **Start Mr. Mik.cmd** from the extracted portable folder to open its MyHub directly. In the installed app, choose **Create a new Hub** (default `Documents/Mr. Mik/MyHub`, or a new MyHub inside another parent folder) or **Open an existing Hub**. Creation includes starter examples and skills and refuses to overwrite existing folders. Opening reuses a Hub containing `workspace/workspace.json`; it is not an import. The installed app remembers its chosen Hub across updates. Each portable location has a separate launch/window profile; opening it never replaces the installed app’s Hub choice. Direct portable executable launches also discover the sibling MyHub (or legacy Hub). An explicit --repo launch uses an isolated profile rather than changing the installed default. Native agent accounts and configuration remain shared. A missing saved Hub prompts again. Restore an archive later through **Settings → Transfer Hub → Import**.
2. Install and sign in to at least one supported agent CLI separately. Codex, Claude Code and OpenCode V1/V2 have dedicated integrations; Kimi has limited support and PowerShell is a local shell, not an AI agent. Mr. Mik does not supply an account or copy an agent's login.
3. In the right rail, open **Workspaces** and add a workspace. Give it a name; optionally pick its first linked project folder with **Browse…**, or leave it blank for a Hub-only planning workspace. The folder need not be a Git repository. Add further linked folders, such as Unity and Blender, under **Linked projects**.
4. Use the selector at the top of the right rail to switch between **Mr. Mik Hub · Global** and a workspace. The selection changes the Hub view and defaults for new actions; it does not move files or redirect an already-running chat.
5. Open **Chats → +** to create a named chat, or use an agent-icon **+** on a workspace/card as a shortcut. Start with normal CLI permissions; bypass is a deliberate choice.

The right rail is your control center: Workspaces, Files, Knowledge, Processes, Inbox, Skills, Tools, Settings and Help. The left navigation and cards remain available in Workspace.

**First-use check:** after starting a chat, ask the agent for its working directory and compare it with the linked folder selected in New chat. This verifies the operational scope more reliably than the workspace label alone. If the folder is wrong, close that chat and create a new one with the intended Working project; changing the workspace selector does not redirect an existing terminal.

## Hub, workspaces, linked projects and cards

### Mik’s Midnight Workshop · optional example

New portable packages and Hubs created during installed-app first use include **Mik’s Midnight Workshop**, a fictional coffee-and-biscuits game workshop. In an existing Hub, choose **Workspaces → Add example workspace**. This is explicit: app updates do not add examples to your personal Hub automatically. Repeating the action selects the existing example instead of replacing edited pages.

The four cards are **Welcome to the workshop** (pinned, with Start here and Field guide tabs), **The midnight espresso engine** (feature report), **Caps, crumbs & characters** (art brief and clickable/downloadable local SVG), and **Operation: one more biscuit** (launch plan). Pages are offline, editable HTML with section navigation; no API, real project folder, MCP or skill activation is required. All tasks, metrics and plans are clearly illustrative rather than completed work.

The example has no linked folders. You can also create an ordinary workspace with the first linked folder left blank, then add a real folder later. Cards and new chats use Hub planning until a working project is selected. Tools without a linked folder show global configuration; there is no native project configuration destination yet. Hub skills and libraries still support workspace scope.

Example cards do not disappear merely because their dates are old. Archive or delete them with the standard card actions. Removing the example workspace offers Keep, Archive or Delete for its cards. Adding after removing the workspace creates a fresh example without modifying previously kept cards or custom shared report styles. Transfers preserve its identity, pages and SVG; an imported example is recognized rather than duplicated.

| Term | What it is | Example | What happens when selected |
| --- | --- | --- | --- |
| Hub global | Shared organizational area | Reusable 3D workflow | Shows global library and cards |
| Workspace | One logical endeavor | Game X | Filters Hub material and provides defaults for new actions |
| Linked project | An external working folder | `GameX/Unity` or `GameX/Blender` | Can become a chat's working directory and target of native project settings |
| Card | A collection for one area of work | Gameplay or Character art | Holds several pages/media in the Hub and optionally points at one linked folder |

**Hub global** holds material shared across workspaces. A **workspace** is one logical endeavor, for example “Game X”. A **linked project** is an external working folder inside that endeavor, such as a Unity folder or a Blender folder. A **card** collects one area of work, with multiple HTML pages, Markdown notes, images, videos and linked artifacts. You can have several cards for the same linked folder, or a workspace-wide card with no linked folder.

In **Workspaces → Add workspace**, choose a name and optionally an external folder. Git is optional; leaving the folder blank creates a Hub-only workspace. Registration records a location only when provided; it does not copy that folder, create CLI settings, grant trust or start a chat. Under **Linked projects**, name and add each further folder. Use **Edit** to relink a folder after moving to another computer. A linked project must not be inside the Hub or contain the Hub.

To disconnect one external folder without removing the entire workspace, open that workspace's settings and choose **Unlink** beside the linked project. Close chats currently working in that folder first. A workspace must retain at least one linked project; if unlinking the main one, select another to become the new default. The original folder and its native agent settings are not changed. The confirmation lists only cards associated with this folder and offers Keep (default), Archive or Delete. Kept or archived cards stay in the workspace but lose their default association to the removed folder; Hub artifact and technical-document links into it are removed without deleting their source files. Old chats remain in History with their original paths but cannot resume as linked-project chats after unlinking; start a new chat for that folder if you link it again.

Create a card with **Create card** in Workspaces or the **+** beside **Files → Main folders → Cards**; you can also ask an agent to create one through the Workspace Bridge. The form asks for a title, optional description, category and optional linked project. Category changes the card's label and icon, not its storage or permissions; linked project sets the default working folder for quick chats. You can associate an existing card while creating a workspace. A card can be assigned to a workspace and, optionally, to one linked project. An unlinked card uses the workspace planning area. The card's Hub pages and assets stay inside Mr. Mik in either case. A card can be pinned from its own view; pinned cards appear in the Pinned section. Removing a workspace registration opens an in-app confirmation with Keep (default), Archive or Delete for all its cards. Kept/archived cards move to Global Hub; libraries and associated Inbox items also become global/unassigned without moving their physical files. External folders and native chat history are not deleted. Close the workspace's chats and finish or stop Mik before removing it.

### Card actions, storage and recovery

On the home grid, right-click a card or press its small **…** icon. The same icon is at the right end of the banner of an opened card, with distinct Archive/Restore and Delete icons in its menu. The banner contains card commands; multi-page navigation such as Start here and Field guide lives inside the content area below it. Single-page cards do not show a redundant page tab. **Archive card** hides it without removing its contents; unpins it as well. Open the left navigation with Mr. Mik's nose, choose **Show archive**, open the card, then choose **Restore card**. Restoring makes it active and updates its date.

**Delete card…** opens a themed confirmation. Close all chat tabs associated with that card first. The card entry is removed from `<Hub>/workspace/workspace.json`, and only its validated `<Hub>/workspace/<card.folder>/` content folder is sent to the Windows Recycle Bin. An empty card may have only a registry entry and no folder yet; it can still be deleted. Old unlinked/orphaned cards can be deleted in the Global Hub view. External artifact targets, linked project folders, Knowledge, Processes, Inbox and native CLI chats are not deleted by a card action. Existing chat history loses the removed card association but keeps the original working folder and native ID.

Recycling uses a private recovery stage at `<Hub>/.mrmak/card-recovery/<operation>/`. If Windows fails or does not confirm in time, the app warns you and unrecycled content remains there. `recovery.json` lists the original card/folder and pre-change registry. Do not publish this folder. Recover files from the Recycle Bin or retained `content-*` folder; restoring their directory alone does not recreate the removed registry entry. Restore a reviewed Hub backup or recreate the card and import the recovered files. Shared styles, planning folders, outside links and folders shared by another card are rejected, not recursively deleted.

Fresh full/light Hub exports and workspace snapshots reflect the current registry: archived cards remain transferable; deleted cards and staged recovery content are excluded. Updating an existing content snapshot requires its normal preview/confirmation. Importing an older backup can restore previously removed cards; an import is not a cross-computer deletion synchronization service. Native chats remain governed by the separate History deletion/transfer actions.

Example: “Game X” can link `GameX/Unity` and `GameX/Blender`. Put “Gameplay” and “Optimization” cards on Unity, “Characters” on Blender, and “Launch plan” on the workspace without a linked folder. A Blender chat can discover the other linked-folder path, but that does not grant a special cross-folder write permission; the CLI's normal permissions still govern access.

**Walkthrough — create this example:** use **Workspaces → Add workspace**, name it “Game X” and browse to the Unity folder. In the same workspace, use **Linked projects** to add the Blender folder. Create a **Gameplay** card and choose Unity as its linked project. Create a **Launch plan** card with no linked project. The card pages remain in Mr. Mik in both cases; only the shortcut's default working directory differs. You may keep several HTML pages, Markdown documents, images and videos in a single card. Pin a card from its own view to display it in **Pinned**.

Registering or relinking a folder records a path; it does **not** copy the folder, install an MCP, create `.codex`, grant Codex trust or import the project's files into the Hub. For native settings, the linked project is the exact folder selected for that action. With two linked folders, Unity and Blender can have different MCP/skill settings even though they belong to the same workspace.

## Chats and working folders

**Walkthrough — open a project chat:** in the Chats window press **+**, choose the agent, enter a recognizable name, select the workspace, optionally select a card, then select the **Working project**. Review the displayed working folder and the permission-bypass choice before opening. A card proposes its associated folder but the full dialog lets you change it. For a fast associated chat, use the card's Codex, Claude or OpenCode icon with **+** instead.

In **Chats → +**, choose an available agent, a descriptive name, a workspace, an optional card and **Working project**. The selected linked folder becomes the CLI working directory. **No linked project · workspace planning** uses a local planning folder instead. With **Hub / custom folder**, supply a working folder directly. A card selection proposes its linked folder, but you can choose another before opening. The selected working folder matters more than whether Git is present.

The **New Codex chat**, **New Claude chat** and **New OpenCode chat** shortcuts are compact agent-icon buttons with a small **+**; hover or focus to identify them. On a card they open immediately using that card's linked project, or the workspace planning area when no linked project is attached. The workspace-home shortcuts start planning rather than silently choosing its first linked folder. Use the full New chat dialog whenever you need a different agent, working folder, card, permissions or an existing native session ID.

Codex, Claude and OpenCode workspace chats receive an invocation-only **Workspace Bridge**. A supported agent chat opened in the Hub root also receives the global Bridge; a custom-folder chat does not. Its startup description includes only the current workspace, selected card and linked working project. Card, library, skill and tool details are discovered on request instead of loading the entire Hub into every chat. It can list workspace names and linked folders, but listing another workspace does not switch this chat's scope; open a chat in that workspace to change its contents. It can read limited non-private text from linked folders, but does not silently copy the Hub into them or make other folders writable. Native `AGENTS.md`, `CLAUDE.md`, project skills and MCP settings remain the agent's own mechanisms. A chat keeps its original working folder and native conversation identity even if you later change the workspace selector or relink a folder.

Mr. Mik supplies a short, chat-scoped **destination rule** when launching or resuming a supported Codex/Claude/OpenCode chat. Each Chats tab shows the chat name and its **workspace · working project**; the line beside Model shows the associated **Card**. The working-folder path remains in the tab tooltip. “This card” refers to the card associated with the chat, not whichever card is open in the other window. Hub content belongs in its resolved Hub destination, never in Unity or Blender's working folder. Technical project files remain in that project's filesystem. Ask when the destination is unclear. This is compact guidance, not a guarantee of model tool choice: verify consequential writes. Existing running sessions acquire new instructions only after resuming; MCP updates apply when safe or remain pending.

**Native Hub file authoring:** the agent calls `mrmak_hub_destination` for the exact card directory/page, Knowledge, Process, Context or skill path. Resolving a card without a title or page path lists its registered pages without loading content. The agent reads and edits the original file with native CLI tools, then calls `mrmak_register_hub_file` with only the destination ID. Registration validates the existing file and updates metadata; it does not generate, copy or replace document content. Whole HTML/Markdown documents no longer travel through Bridge writing tools. Context and skill authoring require explicit approval. Metadata, Inbox import/assignment and skill/MCP switches retain dedicated actions. Never edit internal registries directly.

Codex receives existing card/library content directories only when its configured sandbox explicitly permits additional workspace-write roots; read-only and custom profiles are not silently relaxed. Claude receives additional working directories without changing permission mode. OpenCode V1/V2 retain native external-path permissions: Mik adds no automatic allow override. New destinations outside startup roots can require native approval. **If access is denied, stop:** there is no Bridge document-writing fallback. Registration is not a backup or transaction around earlier native edits. Destination IDs are temporary and chat-scoped: resolve again after restart. New files still consume generation tokens; small native patches avoid rewriting complete documents, but terminal output may still show native writes.

**Ask a chat to organize the Hub:** in a card chat, “add a page explaining this feature” uses that card by default; ask for another card by name if needed. “Save this lesson in Knowledge” creates a Markdown document for the chat's workspace; say “globally” for a reusable Hub-wide item. The same applies to Processes. Existing Hub-owned Markdown documents can be revised after the chat reads their current content; stale or truncated versions are not overwritten. Linked technical documentation is never edited through this operation. The chat can list Inbox items, associate or unassign an item, and copy an explicitly selected non-private file from its linked project into the shared Inbox. Global Context can be listed/read on demand and changed only after approval; keep project-specific technical rules in the linked project's own instructions. If more than one linked project is registered and none is selected for the chat, name the target before changing its native configuration.

**Ask a chat about Skills or Tools:** it can inspect Hub skill switches, native skill names, declared MCP servers and supported Codex/Claude/OpenCode plugin settings, then use the same configuration services as the right rail for supported changes. State the agent, exact item and scope—for example, “disable this Hub Codex skill only in Game X” or “add this MCP definition only to the Unity linked project.” Configuration changes require explicit approval. Mik applies supported MCP changes to affected safe chats, or leaves a pending update. Native skill/plugin changes made through Mik use protected same-conversation resume rather than live MCP reconnect. A saved definition does not install or authenticate its server. Native plugin identities, host-managed components and some externally owned settings do not support the same actions; the chat must report such limits rather than claiming success. The right rail remains the direct visual way to review these settings.

**Codex permissions** offers three choices in Settings and the new-chat dialog:

- **Native CLI configuration:** no sandbox or approval override; Codex uses its own configuration.
- **Full access · ask for approval:** no filesystem sandbox, with `on-request` approvals routed to you. Routine permitted commands run directly; commands requiring review can ask in the terminal. This is broad access, not a safer filesystem sandbox, and explicit policy denials remain blocked.
- **Bypass · no approvals:** retains the existing unrestricted/no-prompt mode. This does not override explicit denials and may reject a command that would otherwise require confirmation.

Existing Codex chats retain their previous native/bypass choice. To change permissions in the **same conversation**, use **Chat options → Codex permissions**. Mr. Mik restarts the CLI and resumes the same saved conversation in the same tab automatically. Busy requests, typed drafts, approval prompts and native menus defer the restart until the terminal is idle and empty; the footer shows the pending change. No Apply button or trip through History is needed. Missing native context or failed preflight never kills the current CLI; errors stop automatic retries. Close/reopen through History remains the recovery path if an automatic restart fails. A default change in Settings only affects newly created chats. Forks inherit the saved per-chat choice. No native/global Codex configuration is rewritten. Organization policies and OS access still apply; approvals are not guaranteed for every rejected command.

**Bypass permissions · other agents** keeps the existing behaviour for Claude, OpenCode and Kimi; it is separate from the Codex selection. **Settings → Chats → Default worker reasoning** selects separate defaults for new Codex and Claude chats. Existing chats keep their saved effort. Previous installations retain their compatible defaults; fresh Claude defaults to high if no compatible value exists. Agent installation and sign-in happen outside Mr. Mik. Dedicated temporary-folder management is not implemented; these choices do not automatically clean temporary files.

Chats are not tied to the workspace selector after creation. A chat created for Unity remains in Unity even if you switch Workspace to Blender or Hub global. A newly created card chat without a linked project opens in `workspace/planning/<workspace-id>` inside the Hub, not in an arbitrary first project folder. Older planning chats retain their original AppData working directory when resumed on the same computer. Use **Hub / custom folder** in the full New chat dialog when you deliberately want a different working directory.

## Working in the terminal

Chats are real CLI terminals, not simulated conversations. Use the CLI's own commands and prompts. Tabs can be reordered and colored; the chat menu also offers rename, pin, working-folder reveal, font size, terminal appearance and **Clear terminal scrollback**. Clearing scrollback does not delete the agent's native conversation.

For a running Codex chat, **Model ▾** asks that same CLI for its native `/model` choices and applies the selected entry in the same terminal. The menu may decline to open while a draft is present or if the CLI output cannot be parsed; then use Codex's own picker in the terminal. Mr. Mik does not provide the list independently. The current reasoning level is retained when possible, otherwise Codex decides its default.

**Reasoning ▾**, next to Model in Codex/Claude terminal chats, opens the native reasoning choices for the active model. Codex reaches these through its `/model` picker without choosing a different model; Claude uses `/effort`. Mr. Mik verifies the highlighted choice, confirms with the native session-only key (`s`) and saves the effort in its History only after native confirmation. These controls do not restart the terminal or change worker defaults in Settings. Wait for an idle, empty prompt before opening them. Unrecognized layouts, account/model restrictions or cache-warning confirmations stay in the terminal for you to handle; Mr. Mik never approves an unknown dialog. Do not confirm with Enter when you intend a session-only change, because the native picker can save a personal default.

**Fork:** the fork icon beside the existing **+** branches the selected idle Codex or Claude conversation. Its native conversation ID must have been captured and its transcript must exist. The original stays open and unchanged; the branch inherits workspace, linked project, card, working folder and permissions. Native CLI fork support is required. If the source cannot be found, reconnect it in History first; creating a new chat is not a substitute for a fork.

**Send / Stop:** the small icon at the bottom right of the chat, in its status bar, alternates between Send when idle and Stop while working. Its position stays fixed, including when scrolling the terminal. Type in the CLI's own input area: Send submits that existing draft with Enter, not a separate Mr. Mik message. Stop sends the native Escape interruption to the selected Codex/Claude terminal without closing it or undoing completed changes. Permission prompts still require your own action; the control is disabled for idle attention prompts. The terminal's own keyboard controls remain available if activity detection lags. Codex's “Conversation interrupted” message is expected after stopping a response.

Paste an image into a chat to save a copy in the Hub Inbox and insert its path into the terminal without submitting the message. The current chat's workspace determines its Inbox association; for an unassigned chat, the selected workspace is used. Drag files or folders into the terminal to insert paths. Clipboard images and linked-file paths can contain private information: review before sending to an agent. The built-in voice chat is currently disabled; an API key is not needed for text chats.

## Chat History, archive and deletion

History and the agent's native conversation store are separate. Mr. Mik stores its own listing and last terminal screen; the underlying Codex/Claude CLI stores a native session. A chat started outside Mr. Mik does not appear in Mr. Mik History unless you explicitly resume/import it through the New chat flow. Conversely, a native chat started through Mr. Mik may also be visible to that CLI outside the app.

| Action | Mr. Mik History | Native CLI conversation |
| --- | --- | --- |
| Close tab | Kept, unless the chat is empty | Kept |
| Archive | Hidden from ordinary History, recoverable via Archived | Kept |
| Remove from Mr. Mik | Removed with saved screen | Kept when a native ID exists |
| Delete native chat | Removed after controlled confirmation | Deleted only when an eligible session is identified |

Closing a chat tab keeps a conversation in **History**. An unused, empty chat is omitted. History has search, workspace and agent filters, Pinned and Archived views. Pinning is for quick access; **Archive** hides a closed chat from the ordinary list, and **Restore** brings it back. Archived chats are not deleted.

**Remove from Mr. Mik** deletes only the Hub history record and saved terminal screen. If a native CLI ID exists, that CLI conversation remains outside Mr. Mik and can be resumed by ID. **Delete native chat…** is a separate, controlled action for an eligible closed Codex or Claude chat. It shows the exact targets, requires the chat name and may be unavailable if the native conversation cannot be uniquely identified. It removes native data as well as the Mr. Mik entry, so export first if you may need it later. A conversation started outside Mr. Mik is not automatically imported into History; use **Resume an existing CLI conversation** with its native ID to bring it in.

If History reports that a native conversation cannot be located, the saved screen stays visible. Use the recovery prompt with the native ID, check that the correct CLI account and local session files are available, and check that the linked folder has been relinked. A saved screen alone cannot reconstruct a missing native transcript.

## Files and the shared library

**Walkthrough — inspect without changing a linked project:** select the desired workspace, open **Files → Main folders** and inspect its Hub Knowledge/Processes/Inbox. To inspect the actual Unity or Blender folder, deliberately switch to **Browse files** and select that folder in **Root**. Before using a context-menu delete in Browse files, confirm which Root is active: recycling an external file really changes that external folder.

| Collection | Scope | Recommended content | Storage behavior |
| --- | --- | --- | --- |
| Context | Hub global | Identity, broad goals and universal preferences | Hub files only |
| Knowledge | Global or workspace | Decisions, reference documents and lessons | Hub copies; external technical documents only when explicitly linked |
| Processes | Global or workspace | Reusable procedures | Hub files, never automatic jobs |
| Inbox | One physical Hub intake area, optional workspace association | Screenshots and incoming references | Assignment is metadata; the file need not move |

**Files → Main folders** presents the Hub's Context, Knowledge, Processes, Inbox and Cards for the selected scope. Changing workspace keeps you in the Hub view; it does not automatically browse the external project. **Files → Browse files** is the explicit filesystem browser: choose the Root to inspect the Hub or a linked folder. Browsing a linked folder is a user action, not an automatic transfer. Markdown can be previewed and edited; other supported media open in the preview. You can copy files in, drag within the browser and reveal paths in Explorer.

Right-click a file in either Main folders or Browse files for **Open in Explorer** and the applicable removal action. Hub-owned files can go to the Windows Recycle Bin, after confirmation. An externally linked technical document offers **Remove link from Hub** instead; this does not delete its original. In Browse files, be careful when a linked external folder is selected: moving its files to the Recycle Bin really changes that folder. Cards are logical containers, not file-delete targets in Main folders.

**Context** is Hub-global: identity, goals and truly shared preferences. Keep project-specific technical rules in each linked folder's own `AGENTS.md` or equivalent, not in Hub Context. **Knowledge** stores reusable notes or workspace-scoped knowledge. **Processes** are reusable procedures, global or workspace-scoped; they are not scheduled jobs and never execute automatically. **Inbox** is one physical Hub intake folder; a file may be unassigned or associated with a workspace without moving it. The dedicated Knowledge, Processes and Inbox rail sections remain useful as the collection grows.

Use **+** on a library folder to import a copy into the Hub. Ordinary Knowledge/Processes files under `knowledge/` and `processes/` are global unless assigned; workspace material can be stored under their project folders. Technical documentation may instead be *linked* from an external project when that explicit option is used; the original stays outside the Hub. A link's path must still exist after transfer to another computer. The Bridge searches global plus relevant workspace material on request; it does not preload every document into every chat.

## Skills: Hub and linked project

New source/portable Hubs include public defaults enabling **workspace-authoring** and **feature-handoff** for Codex and Claude. Other skills remain Off. Override either core skill to Off in a workspace, or disable it globally. Updates do not apply these defaults to existing Hubs; their switches remain unchanged. Public `projects/skill-defaults.json` supplies initial values only while `projects/skill-scopes.json` is absent; saved scope settings take precedence.

Chats and Mik receive a short rule to discover enabled skills, consult the authoring guide before requested Hub card content, and read the handoff skill before a handoff. Empty-card creation and metadata-only changes do not need an authoring read. Skill content is read only when relevant and reused while in context; no full catalog is preloaded. This is model guidance, not a guarantee that every model follows it. Existing live chats normally need resume/relaunch to receive updated launch guidance.

**Optional game pack (0.2.1):** six workflows are included for animation integration, audio, level design, game UI, VFX and gameplay visual review. Each starts **Off** in the Hub controls for Codex, Claude and OpenCode. Select Hub global to share a workflow with all workspaces, or select a workspace to use On/Off/Inherit for that workspace only. The workflows do not install engine tools or paid providers. They use the Bridge for Hub reports and respect the linked project's instructions for source/assets.

An installed/portable update adds only missing game-pack folders to the Hub you open. Existing folders, including customized files, and scope settings are preserved; an already configured skill is not reset to Off. No linked-project folder is changed by this installation. The switches gate Bridge availability; native Codex discovery inside the Hub itself remains a separate CLI mechanism.

**Walkthrough — share a skill but disable it in one workspace:** under **Skills → Codex → Hub**, make the skill **On** in Hub global. Select a workspace where it is inappropriate and set that skill to **Off** instead of **Inherit**. Other workspaces continue inheriting On. Repeat under Claude or OpenCode as needed: availability switches are agent-specific. OpenCode shares canonical `.agents/skills` files with Codex; Claude uses `.claude/skills`.

Use **Skills → Linked project → +** when a skill belongs inside a particular external folder. If multiple linked folders exist, choose the intended one first. This explicitly writes a native `SKILL.md` in that folder, creating missing skill directories; it is different from enabling a Hub skill through the Bridge. Mik requests protected resume for affected chats when safe; check native availability after applying the update. External edits require reopening/resuming the chat.

Open **Skills** and choose **Codex**, **Claude** or **OpenCode**, then **Hub** or **Linked project**. Hub skills are files in the Mr. Mik Hub (`.agents/skills` for Codex and `.claude/skills` for Claude). Linked-project skills are native files in the selected external folder. The **+** form creates a `SKILL.md` in your chosen location and creates missing skill directories, but never overwrites an existing skill. With multiple linked folders, select the intended one before browsing or creating.

In the global Hub view, **On** makes a Hub skill available to all workspaces; **Off** leaves it disabled globally. Within a workspace, **Inherit** follows that global setting, while **On** and **Off** override it for that workspace. Codex, Claude and OpenCode have separate Hub scope settings. New chats know how to discover enabled Hub skill names and short descriptions when a workflow is relevant, then read full instructions on demand; autonomous use is helpful but not guaranteed. Hub skills are not native `$`/slash-menu skills in an external linked folder. Linked-project native skills are discovered by the relevant CLI at chat startup; changes made through Mik request a protected resume of the same conversation when needed; external edits require reopening/resuming the chat. Native skill controls appear for supported agents in the linked-project view. Claude uses skillOverrides in .claude/settings.local.json: On/Off override availability and Inherit removes the local override. Plugin skills use their plugin switch instead. In Claude chats started under the Hub, invocation-only settings suppress native Hub skill discovery so the Bridge remains the availability gate. This does not edit skill files or global Claude settings. Codex Hub-root native discovery remains unchanged. OpenCode shares the canonical Hub skill files but has independent Bridge scopes; its native Hub suppression follows the appropriate V1/V2 adapter.

## OpenCode V1/V2

**V2 configuration:** the editor understands native `mcp.servers` and `disabled`, ordered `permissions` rules and configured skill-path arrays. A V2 linked-project MCP definition replaces the global server entry, so an On/Off override must retain its transport/options rather than write only `enabled`. Mr. Mik can copy safe options and environment/file references into an override; sensitive literal credential fields require explicit project configuration. Inherit removes an unchanged Mik-generated override, but preserves externally edited definitions. Plugin declarations remain read-only until their native identity is known; verified exact-ID controls are described below. Native configuration refresh uses the protected path described below. Full V2 conversation transfer is available with the family, attachment and recovery limits described below. Accounts reads integration metadata only; login/logout stays in the explicitly confirmed native terminal. No authentication material is saved by the status reader.

### MCP changes in open chats

**V2 conversation transfer:** full Hub export carries standalone and bounded same-folder V2 families in their native typed-message format. Import into a fresh destination uses native commands and relinks every member; exact duplicates are skipped. If the archive continues the local messages without rewriting them, preview shows Update. Because native V2 import is create-only, Mik validates both the incoming family and recovery family in disposable databases, writes a verified recovery backup under `.mrmak/import-backups`, and replaces the closed native family while retaining IDs and local permissions. Failed replacements attempt to restore and verify the whole original family; confirmed partial fresh imports are cleaned up only when their content matches the reviewed plan. A newer local history is kept; divergence anywhere prevents a partial merge. Close all chats and other applications using these sessions before import: native commands do not offer an atomic conditional replacement, and Mik's lock does not control external clients. If recovery/cleanup cannot be verified, or a crash leaves a lock, keep the backup/source archive and request recovery assistance rather than retrying or deleting files blindly. Light export remains available for unsupported cases. Revert state, cross-folder location-switch histories and queued or unfinished work remain guarded. V1/V2 archive formats are identified separately; automatic conversion is not offered. Permanent deletion lists every family member, protects separately associated child chats and verifies recursive native removal. Native command profiles do not transfer sign-ins or configuration.

**V2 forks after transfer:** a native fork already has a copied history and distinct message IDs. Export preserves that history and the chat ID, and records its original source/boundary in `mrMikFork` metadata. After import it is a resumable independent conversation, not a recreated native fork relationship: OpenCode's importer does not restore that boundary link. The original native source is not automatically imported or deleted with the fork. This does not preserve all operational instruction state or undo snapshots. Tool references to child sessions outside the fork's own family remain unsupported rather than silently dropped.

**V2 attachments:** files sent with a prompt already contain historical bytes. Full export retains those bytes and replaces the original URI provenance with an inline source, without rereading the original path; a file changed or removed afterward does not alter the archived attachment. Tool-produced file references are different: review their paths and sizes, then explicitly approve copying them. The existing export review is single-use and rejects changed files/chats, remote/private/missing paths, symlinks/junctions and excessive sizes. Imports carry approved data inside the native JSON rather than writing arbitrary external paths, and native validation runs in a disposable database before destination writes. If the local chat still references a tool path while the archive embeds its bytes, Mik conservatively reports a conflict; it does not read local files to infer equivalence.

**V2 plugin controls:** open an OpenCode V2 chat for the chosen folder, then refresh Tools. Mik reads the native server-plugin catalog and shows verified IDs separately from package declarations. Builtin/SDK components and Mik's own adapters are not offered as switches. Off writes `-actual.plugin.id` in the chosen configuration; On/Inherit removes that exact exclusion there. On does not install a package or bypass a remaining inherited/wildcard exclusion: edit that exclusion at its source. Global controls are available only for a verified global source. Identity proof is held in memory, not exported, and must be reacquired after restarting Mik; existing policy files remain saved. These controls also accept approved Bridge requests. CLI-only TUI plugins remain separate.

**Native skills and plugins:** native skill switches, linked-project skill creation and Markdown saves through Mik now use the same protected configuration-update mechanism. Comparisons include discovered skill contents, native enablement/approval policy and declared plugin versions/options, not full instructions in chat metadata. A native skill/plugin change requires protected resume of the same conversation; it is never sent to an MCP reconnect endpoint. Hub Bridge skills remain on-demand and do not cause this restart. Disabled instructions already read earlier cannot be erased from the model's existing context. This is not a background watcher for external edits, auxiliary skill files or arbitrary installed-plugin file changes; reopen/resume after making those changes. Native discovery, trust and managed policy remain authoritative.

**V2 skill names and sources:** the visible name can differ from the native ID used for permissions. Mik uses the folder ID for nested `SKILL.md`, or the filename ID for direct Markdown in a skill source, not the display label. Singular/plural source folders and configured paths are supported; relative configured paths resolve against the chat's working folder. Hover a skill name to inspect its native ID. “Native approval may be required” means the saved policy asks for confirmation, not that the skill is disabled. With an owned V2 chat open for that folder, refresh reads the native metadata catalog and can show remote sources already loaded by OpenCode. Mik does not download them or retain their instruction bodies in control receipts. Without that catalog, the list is a local file/configuration inventory, not proof of runtime availability. Native forms and permission prompts remain in the terminal; resolve them before using chat controls.

When you change MCP settings through Tools or an approved Bridge/coordinator request, Mik compares the effective configuration for each open chat's agent and working folder. Unrelated agents and folders whose overrides leave the result unchanged are not restarted. Idle chats with a verified empty native prompt can update automatically. Busy chats, drafts and open native menus remain pending; finish the task, clear/send the draft and use the small refresh action above the terminal. Unknown layouts and missing native IDs never authorize a blind restart.

Existing OpenCode MCP On/Off changes can use native connect/disconnect without restarting. Additions and changed definitions, Codex and Claude use a guarded restart/resume of the same native conversation, retaining its workspace, working project and card. A resumed CLI still needs native trust/approval, a reachable server and valid authentication; a saved setting alone is not proof of a connection. Failures require manual review instead of repeated restarts. External configuration edits are not watched: reopen the chat after editing outside Mik.

Hub skill availability is checked on every Bridge list/read, but previously read instructions remain in the conversation. Native skill switches, skill creation/Markdown saves and supported plugin changes made through Mik participate in the protected update scheduler. Native instructions require same-conversation resume; external/auxiliary-file edits are not watched. Pending update status and private fingerprints are runtime-only and are not exported/imported. A restart supplies the compact orientation as system/developer context; it does not submit another user message or replay previous work.

**Chat controls:** the OpenCode icon with **+** on a card/workspace opens a scoped chat directly, using the card's linked folder or Hub planning when none is assigned. The fork icon beside New chat creates a separate native conversation and keeps the same workspace/card/working-folder association. The Send/Stop icon submits the typed native prompt or aborts the active response; it neither closes the tab nor undoes changes. Native dialogs and permission/questions must still be handled in the terminal.

**Model / Variant:** Model lists the connected native model catalogue with search and provider labels. Selection uses and verifies OpenCode's native picker without restarting the terminal. Variant shows native provider/model variants, not Codex reasoning levels. When a model change opens a variant dialog, Mr. Mik offers its variants automatically. Unsupported layouts, ambiguous options or models without variants leave the native terminal available instead of sending guessed selection keys. These controls were verified with CLI 1.18.34 and the isolated V2 2.0.21 development fixture. V2 uses its own TUI plugin contracts; native forms/permissions, busy chats and autocomplete must be resolved first. Stop requests native interruption, not process termination. On V1, an explicit `OPENCODE_TUI_CONFIG` is preserved and disables the invocation-only Mr. Mik TUI adapter; use native controls in that case. Temporary control/config files are private, excluded from transfers, and regenerated on launch. V2 account, MCP, native skill and verified server-plugin controls use their separate V2 adapter. Bounded family transfer, attachments and guarded continuations are described in Export / Import below. Unsupported native contracts disable the affected operation, not the entire installed CLI; clean-PC and authenticated provider acceptance remain separate checks.

**Availability:** OpenCode V1/V2 integration is included in 0.2.8 packages. OpenCode compatibility is checked by native contracts rather than a version allowlist; CLI 1.18.34 is the tested baseline, not a required release. Install and configure OpenCode and a provider separately. Mr. Mik does not reuse Codex/Claude subscriptions or credentials. New chat uses the same workspace/card/linked-folder associations and scoped Workspace Bridge. Native session IDs and terminal screens are tracked only for chats started here, not by importing unrelated conversations.

**Skills:** choose **OpenCode** in the existing Skills panel. **Hub** shares the canonical `.agents/skills` files with Codex but has independent availability settings. New Hubs enable workspace-authoring and feature-handoff; other workflows default to Off, and explicit choices are preserved. Enable a skill globally, then use workspace Inherit/On/Off as needed. Editing a shared file also changes its Codex copy; enabling it does not. **Linked project** browses `.opencode/skills` for the selected linked folder. Its **+** creates missing folders and a new `SKILL.md` without overwriting files. Native controls also inspect compatible `.agents`/`.claude`, ancestor and global skill locations. On/Off writes a named allow/deny in `permission.skill`; Inherit removes that override. It does not delete instructions. Higher native permission layers may still apply. Hub skill switches gate the Bridge; native discovery while working inside the Hub itself remains separate.

**MCP:** choose **OpenCode** in Tools. Select Hub global for global settings, or a workspace and its intended linked folder for project overrides. On/Off works with existing native definitions, including ones created outside Mr. Mik. For example: define Blender MCP globally, leave it Off globally, select the Blender linked folder and set it On there; leave Unity at Inherit. The installation remains shared. A project Off similarly overrides a globally enabled server. Inherit removes the selected-file override, not independent declarations in other configuration files.

Use **+ Add MCP server → OpenCode**, choose global or selected linked project, enter the server name and HTTP URL or local command/arguments, then save. Mr. Mik writes native `opencode.json`/`opencode.jsonc` settings, preserving comments and unrelated values, with a private backup. It does not install software or configure provider/MCP credentials. Editing/removing complete definitions is restricted to unchanged Mr. Mik-owned entries; foreign definitions can still be enabled/disabled. Plugin declarations are read-only: OpenCode 1.x has no matching per-plugin MCP-style enabled switch. A declaration is not proof of installation.

These are **file inventories, not live connection status**. Custom OpenCode configuration environment variables lock controls, rather than writing an ineffective override. Remote/managed/ancestor configuration and agent permissions may affect actual availability. Changes through Mik use safe live MCP updates where supported, or protected same-conversation resume; pending updates require the terminal refresh action. Reopen/resume after external configuration edits. The Bridge exposes the same skill/tool controls to an OpenCode chat; writes need explicit user confirmation. Remote OAuth connections must be checked in OpenCode itself; Mr. Mik never reuses private native OAuth credentials for its temporary inspector.

**Transfer and limits:** light Hub export includes OpenCode History references/screens and Hub skill scopes, not native conversation data. Workspace snapshots include effective OpenCode Hub skill settings/files and deduplicate shared Codex/OpenCode files on import. Native config, account state and config backups are excluded. Full export lists unavailable/unsupported native conversations for explicit exclusion; healthy conversations can still transfer. Unsafe archive paths or present-file integrity failures remain blocking. Full transfer and controlled native deletion are available for standalone chats and bounded same-folder conversation families when native contracts are compatible; CLI 1.18.34 is the tested baseline. See the limits below. Mik can open, read, send to, interrupt, resume and manage scoped OpenCode worker chats, with the same real UI confirmations. It uses native readiness checks and response abort; unavailable controls leave the terminal for manual handling, never generic key fallback. OpenCode provider/model/variant settings remain native; Mik itself still uses Codex. Real provider acceptance is separate from offline/local-mock tests; see [integration details](opencode-integration.md).

## Tools, MCP and plugins

**Walkthrough — create an MCP only for one linked project:** select the workspace, choose the correct linked folder in Tools, open **+ Add MCP server**, select **Codex** and **Selected linked project**, enter a unique name, then choose HTTP URL or local process command and arguments. Save and start a **new** trusted chat in that folder. Mr. Mik writes the definition in that folder's `.codex/config.toml`; Git is not required. The MCP executable or remote service must already exist. The form does not install it or add authentication credentials.

| State | Meaning | How to verify |
| --- | --- | --- |
| Installed | Executable exists locally, or remote service exists | Check the executable/service independently |
| Defined | A native agent config names its command or URL | Inspect its entry/source in Tools |
| Enabled | Scope setting allows it in a new chat | Inspect Global/Linked project switch and effective config |
| Connected | That chat actually started/authenticated the server | Use the agent's native `/mcp` or equivalent in the new chat |

**Tools** inventories MCP servers and supported Codex/Claude/OpenCode plugins from their actual sources. The agent/type/scope filters narrow the list; the eye beside search shows system and manually hidden entries, which have a different background. An entry's small eye hides it from this list only. **Hiding is not disabling.** The status describes configuration; **Check** opens a temporary connection and does not prove an existing chat is using the server. Check the agent's own `/mcp`, `/skills` or configuration commands inside a newly started chat for effective availability.

Where supported, choose **Global On/Off** for the personal Codex configuration and **Linked project On/Off/Inherit** for the selected folder. An inherited setting follows the global/default state. To make an integration opt-in, turn its global default off and enable it only in chosen trusted folders. A project override may write to that folder's `.codex/config.toml`—this is the explicit exception to Mr. Mik's normal “do not modify linked projects” rule. Codex must trust the project before its project configuration loads, and affected chats use protected refresh/resume when safe; drafts, busy chats or missing native IDs require manual review. Host-managed or plugin-provided entries may be read-only or require changes at their original source; the app does not promise the same switch for every tool.

Use **+ Add MCP server** to create an HTTP or local-process definition owned by Mr. Mik, at global or selected-project scope. It manages only its own marked definitions; manually configured entries remain at their source. Do not put secrets in the visible URL or command fields. Codex global actions request confirmation. Claude user-scope and private linked-project MCP definitions use Claude's own configuration outside the Hub; Claude's shared `.mcp.json` and approval flow are separate. Kimi uses its native MCP files. Installing a server, plugin or CLI is distinct from enabling it; Mr. Mik does not duplicate their installations.

### OpenCode coverage and differences

The OpenCode integration supports scoped workspace/card chats, the content Bridge,
Hub and native skill controls, global/project MCP settings, managed History,
native resume/fork, Send/Stop, Model/Variant and Mik worker coordination. These
adapters have local, isolated native and mock-provider tests; final acceptance
with your selected provider and a clean destination PC remains a separate check. The 0.2.8 packages include these adapters; older downloads do not update themselves.

| Area | OpenCode behavior |
|---|---|
| Hub content | Same scoped card, Knowledge, Processes, Context and Inbox operations; the compact orientation uses an experimental native hook |
| Hub skills | Shared `.agents/skills` files, independent OpenCode global/workspace switches; core authoring/handoff defaults On, other workflows Off |
| Linked skills | Create `.opencode/skills/<name>/SKILL.md`; native On/Off/Inherit changes permissions by name |
| MCP | Inventory, global/project overrides, local/remote definitions and eligible connection checks; safe MCP updates or guarded resume; native instruction changes require protected same-conversation resume |
| Plugins | V1 declarations are read-only; V2 verified server-plugin IDs support exact exclusion controls; no package installation |
| Model/Variant | Searchable native model catalogue and verified native selection; variants without restarting; unknown layouts leave manual terminal control |
| Defaults | Default agent can be OpenCode; no dedicated OpenCode model/variant default in Mr. Mik Settings |
| Mik | OpenCode workers are supported; Mik's own engine remains Codex |
| Native transfer/deletion | Standalone chats and bounded same-folder conversation families with compatible native contracts; precise limits below |

OpenCode authentication belongs to OpenCode. Mr. Mik does not copy credentials
from Codex/Claude or promise that a provider/model can perform every Hub action.
External folders need not be Git repositories. Native configuration, account
access, permissions and model availability remain authoritative.

History shows at most 350 characters of the latest final assistant answer, as
for the other supported agents. The excerpt is private conversation content:
it is saved with Mr. Mik History and included in light/full archives. Only the
exact completed assistant message is read; reasoning, tool output and user
prompts are not included in this additional observation. This does not replace
the saved terminal screen or native conversation. Missing/failed reads leave no
new excerpt, and older chats are not automatically scanned to fill one in.

### OpenCode native transfer and deletion

**Full export** now includes native JSON for supported OpenCode conversations
referenced by Mr. Mik History. Install a compatible OpenCode on both computers (tested baselines: V1 **1.18.34** and V2 **2.0.21**, no release-number pin),
close all chat tabs and other applications using those sessions, export, then
import and relink the external folders. The destination keeps its own credentials
and native configuration. Import registers the destination OpenCode project and
retains the conversation ID. Identical chats are deduplicated; exact extensions
update native data plus History/screens; longer local continuations are preserved.
For divergent OpenCode content, the local conversation and saved screen are kept;
replacement is unavailable. Existing native JSON is backed up before a continuation
update in `.mrmak/import-backups`. V1 native `import` adds missing messages; V2 uses validated family replacement with verified recovery backups because its import is create-only. Mik verifies the resulting content. Database inspection is read-only; native writes use OpenCode commands.

Task lists included in the archive are reference snapshots, not restored native
tasks. Existing native session metadata is retained. This is conversation transfer,
not restoration of token accounting, undo snapshots or all operational state.
Native commands are not an atomic whole-Hub import; interrupted operations may
leave partial changes. Keep the backup and inspect failures before retrying.

**Subagents:** the full archive includes the main chat and its native descendants
as one conversation family. Preview shows the number of sessions. Native parent
links and identities are retained; every member is relinked to the main chat's
destination folder. A new child or extra child messages can update the family.
Divergence in any member keeps the complete local family, not a partial merge.
Only the main chat becomes a History entry. Independent forks remain separate chats.

Families must use one working folder, with at most 64 sessions, depth 16 and
64 MB combined JSON. A separate History association for a child must be removed
before full transfer or family deletion. Missing parents, cycles, overlapping
identities and task references outside the family are refused. Running subagent
jobs are not restarted, and archived task lists are not restored as native tasks.

Full export can include local file/tool attachments after a separate review in
Settings. Review the listed paths and sizes, select **Include all listed files**,
then **Confirm full export**. Nothing is copied before confirmation; consent expires
after five minutes and changed files/chats require review again. Cancel leaves no
archive. Bytes are embedded in the exported native chat, not copied into linked
projects; source chats/files are unchanged. Limits: 128 unique files, 16 MB each,
32 MB total and 64 MB serialized family. Remote URLs, missing files, directories,
symlinks/junctions, network shares and recognized secret paths are refused. Choose
light export when a reference is unsupported. Review contents before sharing;
secret-looking filenames are only a safeguard, not a content privacy guarantee.

An original chat with local file URLs and an imported chat with embedded data URLs
can be treated as divergent: the local branch stays intact. Import does not read
external files to infer equivalence or rewrite existing native messages. Subsequent
transfers between embedded copies retain normal exact-prefix continuation checks.

This is not a complete OpenCode-home copy. Unsupported family dependencies and
native JSON above 64 MB fail closed. Embedded media and Hub files travel; external
code, Git undo/snapshot storage and unrelated files do not. Later CLI versions
are not rejected by number: missing database fields, unsupported JSON or failed
native commands stop the affected operation. Isolated import validation runs
before modifying the destination; incompatible upstream changes need an adapter fix. Session
permission overrides and sharing links are not imported. Transcripts may contain
sensitive text even though account/configuration files are excluded.

To delete a supported closed OpenCode chat permanently, open **History → ··· →
Delete native chat…**, review the session and type its exact chat name. A changed
conversation or duplicate Mr. Mik reference blocks deletion. Mr. Mik invokes
native `session delete` and checks every planned member's absence before removing
History. The confirmation lists the main chat and all children: deletion is
recursive, not a choice to delete only the parent. Changed descendants or another
Mr. Mik chat referencing any member block deletion. Close other OpenCode instances
first; Mr. Mik cannot lock their changes during the native command. A partial
native failure retains History but cannot undo records already deleted.
**Remove from Mr.
Mik** still removes only the local History record, not the native session. Native
deletion affects the selected session's database records, never its external
files or other sessions. It is not secure disk erasure or database compaction;
private import backups remain until separately removed.

## Mik · workspace coordinator

Click the small **Mik icon at the bottom-right of the workspace** to open the floating text coordinator. Click it again or the panel's close icon to hide it; hiding does not cancel a running request. The familiar **Conversation** and **Activity** tabs show the scoped conversation and terminal attention events for this workspace. Mik uses the existing signed-in Codex CLI and the configured coordinator model; it does not use the voice API. The coordinator engine is Codex, while its visible worker chats can be Codex, Claude or OpenCode (or Kimi when installed). Choosing Claude for a worker does not change Mik's engine. Mik does not start a model turn merely because you open its panel; sending a message uses your configured Codex access and quota.

**Choose the target:** the top workspace selector selects **Global Hub** or one logical workspace. Mik has a separate text conversation for each. Optionally choose a **card** and **working project** below its heading. When you open Mik while viewing a card, that card and its linked folder are proposed. Selecting a card proposes its linked project; you can change it to another linked folder or **Workspace planning**. No linked folder is silently chosen just because it is first in a list.

**Send a request:** type in **Ask Mik…** and press Enter or the send icon. Shift+Enter inserts a line break. Mik captures the workspace, linked project, card and selected chat when you send. Changing the app view while it works does not redirect that request. Its conversation and pending confirmations remain under the original workspace; select that workspace again to view them. Requests are processed sequentially. A different workspace can queue a request without sharing the first workspace's model conversation.

Examples:

- “Create a Research card in this workspace.”
- “Save this lesson in workspace Knowledge: …”
- “Show the current card and summarize its notes.”
- “List the MCP settings for the selected Unity project.”
- “Disable this Hub skill for this workspace.”
- “Open a Claude chat for Unity optimization, associated with the Performance card.”
- “Read the Blender chat and prepare a follow-up task for Unity.”

Mik uses the same **Workspace Bridge** for metadata, discovery, Inbox and skill/tool configuration. It remains read-only: both Hub document authoring and linked-project implementation are delegated to a visible worker terminal, which keeps its native permissions. The worker resolves and registers Hub destinations; generated content stays in the Hub. Mik cannot bypass a rejected worker file write. A configured MCP is not proof of a live connection. Installation, account authorization, automatic permission approval and permanent native chat deletion are not coordinator actions.

**Confirmations:** configuration changes, Context writes, explicitly global library changes, new/resumed worker chats, worker messages/attachments, closing and interruption show a confirmation in Mik. Review the target and details, then choose **Approve** or **Decline**. A model-generated `confirmed: true` cannot replace this click. An unanswered confirmation expires after two minutes without applying the action. The coordinator must read a worker's current terminal before sending or attaching; a changed process, intervening user input or ongoing work blocks delivery. Native login or permission prompts must be handled by the user, not approved by Mik.

**Stop request:** while Mik is processing, the Send icon in its composer becomes a Stop icon. It interrupts the coordinator request, not its worker chats, and does not undo actions already completed. Drafting another message or pressing Enter while it is working does not submit or stop that request. Check the resulting message before retrying an interrupted operation. Mik does not continuously poll worker chats, wake itself later or automatically continue a pipeline after replying. Ask it again to inspect progress. For cross-workspace writes or worker-chat operations, select the destination workspace and send a new request; listing other workspace names does not authorize operations there.

**Card and working project:** selecting a card automatically fixes the working target to that card's linked project, displayed as a read-only label. An unlinked card uses Workspace planning. There is no second project selection when a card is selected. Choose **No selected card** to select a linked project independently, or leave Workspace planning selected to organize the workspace as a whole. The service also rejects conflicting card/project targets. This does not prevent explicitly asking Mik to coordinate work across Unity and Blender within the workspace; the card is the default Hub destination, not a restriction on consulting other registered projects.

**History and context:** requests, responses, statuses and stable target IDs are saved privately in `.mrmak/mak-history.json`; `.mrmak/mak-conversations.json` tracks conversations and the selection for each workspace (or the configured runtime state directory). Mik now uses persistent native Codex threads. Closing its panel or restarting the app preserves the conversation; the next request resumes its native thread, rather than injecting six text excerpts. Normal native context management and quota consumption still apply when sending a message. Library documents, skill instructions and detailed action schemas are loaded only when needed, not all at startup. Old ephemeral Mik conversations cannot be recovered as native threads: their saved receipts remain under **Previous Mik History · view only**. Use **New Mik conversation** to continue with a fresh context.

**Conversation controls:** the small **+** starts a separate Mik conversation without deleting the previous one. The adjacent fork icon creates a native branch of the selected conversation, retaining its prior model context and visible exchanges; subsequent requests are independent and do not replay old actions. The History icon opens the saved-conversation selector for the current workspace. Conversation changes are blocked while Mik has a request pending. If reconnection fails, **Retry connection** retries the same native conversation without discarding History. New conversation is the clean-start alternative; fork requires a recoverable native source, so it is not a guaranteed cure for a broken transcript. **Activity** shows worker notices and links to their terminals, not another chat composer or target selector. Pending confirmations remain visible there.

Both **light** and **full** exports include Mik's text History and conversation references, including forks. **Full** also includes available native Mik transcripts, using the same native duplicate/conflict review as worker chats; use it to resume on a different computer. **Light** preserves visible exchanges but cannot restore missing native model context on another PC. Import merges stable operation/conversation IDs without replaying actions, and keeps the destination's existing conversation selection. Native sessions still live in the normal Codex user store and may appear in Codex outside Mr. Mik; no separate login or global tool configuration is created. Credentials and login state are never exported. Wait for Mik to finish or stop its request before exporting/importing; close worker chat tabs too. Use updated builds on both computers and protect archives containing private conversation text.

**Settings → Mr. Mik → Coordinator reasoning** selects the default for **new** Mik conversations. Choices come from the configured Codex model's native catalogue: low, medium, high, extra high, max or other levels appear only when that model declares them. A level saved for a previous model may be marked unavailable; select a compatible level rather than assuming every model supports the same options. The optional `MRMAK_COORDINATOR_MODEL` in the Hub's private `.env` selects its model on startup. Changing a worker's model does not change the coordinator. Voice remains unavailable.

The compact **Reasoning** selector above Mik's message box changes the current conversation for its **next request**. It does not restart the conversation, discard context or change Settings. It is locked while a request runs and for view-only legacy History. A fork inherits the parent's reasoning; a new conversation takes the Settings default. The selected level survives restart and travels with conversation metadata in light/full export. Light export still cannot resume native context without the corresponding CLI transcript.

The adjacent **Model** selector lists the native Codex model catalogue. It changes only this Mik conversation from its next request, retaining the same thread and context. If the new model cannot use the selected reasoning, Mik switches to that model's declared default; the Reasoning selector then shows the compatible choices. Model and reasoning survive restart and export/import, and forks inherit both. Switching to a listed model does not grant subscription access to it. New conversations still use the configured coordinator model/default rather than inheriting a different conversation's override.

Worker defaults are separate from coordinator reasoning. Codex worker choices use the configured Hub model catalogue; a linked project can configure a different native model, which may impose different limits. Claude uses its native low/medium/high/extra-high/max levels, subject to the installed CLI, selected model, subscription and organization restrictions. These controls do not grant access to unavailable models or reasoning levels. If the Codex catalogue cannot be read, its controls remain unavailable rather than inventing a list; close and reopen the panel to retry. Higher reasoning can increase processing time and usage.

Maintainer reference: Mik uses the [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server). Dynamic tools are experimental; regression-check the protocol after a Codex CLI upgrade. Isolated UI tests simulate model decisions; the installed-CLI smoke test verifies persistent resume/fork across restart using fixture context without a model turn. A live model test is still necessary to assess natural-language routing and worker handoffs.

## Settings and transferring a Hub

### Unavailable conversations: partial full transfer

Full export reviews Codex, Claude and OpenCode V1/V2 native conversations, including
saved Mik coordinator contexts. If one is missing, has no verified ID, is ambiguous,
invalid or cannot be transferred safely, the review lists it rather than omitting
it silently. Select **Continue without these native conversations**, then **Confirm
full export**, to include all healthy conversations. You can cancel or recover the
affected contexts and review again instead. The confirmation is single-use, expires
after five minutes and cannot be used to exclude healthy chats. Attachment copying
requires its own checkbox. No files are exported before confirmation.

Import preview also isolates unavailable native contexts, including declared native
files missing from an otherwise readable archive. Select **Continue without these
native conversations** to import healthy chats and Hub contents. Imported exclusions
retain available History and screens with a **Native context not transferred** warning.
They cannot reconstruct or silently restart a lost conversation. Recover its native
context and enter the CLI ID in History to reconnect; Mik contexts retain visible
History and require restored context or an explicitly new conversation. Existing
local History/native contexts are not downgraded by an unavailable incoming copy.

An OpenCode root and its dependent descendants are one exclusion unit. Healthy,
independent families remain transferable. Changed archives or changed availability
require review again. Corrupt/unreadable ZIPs, invalid manifests, unsafe paths,
unexpected entries, checksum mismatches in present files and overlapping identities
remain archive-wide blockers; they are not silently accepted by the skip checkbox.
Unexpected failures during native writes stop the operation under existing backup/
recovery rules, rather than being blindly ignored after partial mutations. Empty tabs
do not require a transcript. Light export remains the all-History/no-native alternative.

### Updating the app without losing your Hub

New portable packages contain `App/` (executable and runtime) and `MyHub/` (content, skills, project registrations and hidden `.mrmak` state). Close the app before updating, keep a full backup, then replace only `App/` and the launcher. Never extract a new example `MyHub` over your existing Hub. The launcher recognises the older `Hub/` name when no valid `MyHub` exists; it also accepts an external Hub folder as its first argument. Existing installed apps can keep opening the same selected Hub.

Preserve the entire Hub, including hidden `.mrmak`, `.agents` and `.claude` folders. Updating on the same computer does not require export/import. Moving to another computer or recovering after formatting requires full export/import if native conversations must be restored. Agent installations, login, native global configuration and linked external projects remain separate. The portable is not a fully profile-isolated environment.


### Restore window layout

The small split-window icon in the Chats header and Workspace top bar restores
both native windows to the initial arrangement: Chats on the left, Workspace on
the right. It uses the monitor of the window where you click and its work area
(excluding the taskbar). The default chat width is 27% of the display, bounded
to 360–560 logical pixels; the Workspace uses the remainder. Minimum window sizes
can prevent an exact fit on very small displays. Hidden/minimized/maximized
windows are shown in the restored layout, without restarting sessions, sending
messages, changing permissions or clearing drafts. Browser-only use does not
control native window geometry.

### Native accounts

**Settings → Accounts** offers Sign in / Sign out for Codex, Claude and
OpenCode providers. The **+** icon (Connect provider) beside the OpenCode heading opens its native provider setup,
including providers that are not connected yet. Connected providers get separate
rows with their own status/sign-out action. Environment-only connections show External setup. V2 supplies exact integration IDs; V1 reports display names, so its Sign out
action opens the native picker: select the intended provider there. Environment-only
V2 connections do not offer Sign out because native logout cannot remove environment
variables. Close the agent's Mr. Mik tabs first and wait for
any Mik request before changing Codex login. Review the shared-profile warning,
then choose **Open native sign-in/sign-out**. A separate visible PowerShell window
executes the native CLI authentication command. It is never pasted into a chat,
and authentication output, codes and credentials are not captured in History,
Hub files or archives. Complete browser/native prompts yourself; opening the
terminal is not proof that authentication succeeded. Cancel starts no command.

Accounts is below **Workspace snapshot · Git**, with one compact agent/status/action
row per CLI or OpenCode provider (status wraps below the name on narrow panels). Green **Logged in** shows only
Sign out; red **Not logged in** shows only Sign in. If the native status cannot
be established, **Status unavailable** keeps both actions. Status is refreshed
when Settings opens and the app regains focus. This is local sign-in state, not
verification of subscription access, token expiry or regional availability.

Native status output stays in memory only for the check and is reduced to a
fixed status; it is never logged, exported or saved with the Hub.

This changes the normal native CLI profile on this PC, including its use outside
Mr. Mik, not just one workspace. Close other clients using that account too, then
reopen chats after completing the change. Mik may need an app restart to load the
new Codex account; the app never closes live conversations automatically. Chats,
cards, MCP configuration and linked folders are not deleted. Environment/API-key
settings can take precedence over stored logins. OpenCode's other providers stay
managed through its native authentication commands. Native CLI errors remain in
the separate terminal; do not delete authentication/config files to work around them.

### Terminal cursor and scrollback

**Clear terminal scrollback** removes only off-screen terminal history, not the
current CLI screen, input draft or native conversation. Fullscreen alternate
buffers usually have no scrollback to clear; the current view stays intact and
no prompt, reset or model request is sent. Existing OpenCode cursors have a local
contrast bar in Mr. Mik, even when native cursor colors match the input background.
The bar disappears when the CLI hides its cursor; native color/style settings and
the CLI installation itself are not changed.

The temporary cursor diagnostics control has been removed. Cursor visibility
and scrollback preservation continue to work without background diagnostic sampling.

### Codex usage and limits

Type **/status** in the native Codex terminal to inspect session configuration,
context/token usage and available rate-limit information. CLI versions supporting
**/usage** also offer account token activity (daily, weekly or cumulative).
Use **/statusline** to select available usage/limit counters for the native footer.
These are native commands, not model prompts. Available fields depend on the CLI
version and sign-in method; context usage is not the same as account quota.

### OpenCode model error recovery

A rejected/unavailable model is an error, not a question requiring a response.
After the native request ends, reopen **Model** and select an accessible model.
**Retry picker** retries a failed menu read without restarting the conversation.
Only the current viewport is parsed; old picker headings in scrollback are ignored.
Real permission/question dialogs and active native responses still block control.
Unknown layouts remain available for manual handling in the terminal.

### Claude-specific controls

Claude has its own native configuration; Mr. Mik does not translate Codex TOML into Claude JSON. The same Hub concepts apply, but the storage and approval mechanisms differ.

- **Tools → Claude MCP → Global On/Off:** Off removes a definition from the active user MCP map and keeps its complete private recovery copy in the Claude profile's `mrmak-disabled-mcp.json`. On restores it. The private copy is not a Claude setting and is excluded from Hub exports. An active/inactive name collision is rejected rather than overwritten. Other explicit project definitions with the same name remain separate.
- **Linked project On/Off/Inherit:** Off uses Claude's native project exclusion. Inherit clears that exclusion and any unchanged local copy Mr. Mik created for an override. On may create a private local copy of a globally parked definition. These operations also work with manually created MCP definitions; editing/removing foreign definitions remains restricted to their source. Native `.mcp.json` approvals are not bypassed by On.
- **Claude plugins:** Global and linked-project controls use native `enabledPlugins` settings. Inherit removes the local override, exposing the shared-project or user setting. A policy-managed installation may still override a personal choice. Installing a plugin remains separate from switching it on.
- **Native skills:** On/Off/Inherit changes `skillOverrides`, not `SKILL.md`. Existing Claude visibility modes such as `name-only` remain intact until you explicitly change them. Settings and CLI discovery are authoritative; this panel is not proof of a running model connection.
- **Model:** in an idle chat with no draft, the button requests the native `/model` picker and mirrors a recognized menu. Selection uses the same running terminal, without restarting. Unknown layouts, login screens, changed menus and missing confirmations stop automation and leave the native terminal usable. This is not a static list of models promised to your account.
- **Resuming:** Mr. Mik resolves only the chat's recorded native ID and rejects duplicates. For CLI versions supporting prompt refresh, resumed Bridge chats also refresh the compact Hub routing instruction instead of retaining an obsolete prompt snapshot.

Permanent Claude deletion lists the transcript, session sidecar and existing session-ID-specific task/checkpoint/upload/image-cache folders in its confirmation. It does not purge an entire project, credentials, settings, shared prompt history, debug logs or temporary data whose ownership cannot be established safely. Full archives may contain private conversation text and file checkpoints: review them before sharing or committing.

The development machine currently has Claude CLI 2.1.283 but no Claude model access. Configuration, isolated UI, transcript transfer and synthetic picker behavior can be tested without a subscription. Actual model responses, account-specific picker output and autonomous Bridge use still require an authenticated live test.

Native reference: [Claude skill visibility](https://code.claude.com/docs/en/skills), [MCP scopes and disabling](https://code.claude.com/docs/en/mcp), [CLI resume and prompt flags](https://code.claude.com/docs/en/cli-reference), [settings scopes](https://code.claude.com/docs/en/settings).

**Appearance:** Settings offers four light accents that fit the existing dark-grey interface: **Rose** (original), **Violet**, **Blue** and **Teal**. The choice updates Mr. Mik controls in both windows, including the softly tinted greys used for descriptions, labels, placeholders and secondary text. Rose retains its original colours; errors, warnings and success indicators retain their meaning across themes. It does not recolor authored card pages or the terminal when **Original CLI colours** is selected. The accent is an app preference, not a different theme per workspace.

**Walkthrough — move a Hub:** close chat tabs, choose **Export · full** if you need available native Codex/Claude conversations, and save the archive securely. On the destination computer, install and sign in to the required CLIs and copy/clone the external project folders separately. Import the Hub archive, relink every folder to its new location, review conflicts and optionally restore app preferences. Then verify a card, an Inbox item, a new chat's working folder and one resumed chat. An export is not a backup of external projects or credentials.

**Settings** controls the Windows shortcut when available, default chat agent, reasoning, terminal text size and appearance, Codex permission default, other-agent bypass default, and coordinator reasoning. Settings affect new chats as described; existing chats keep their native state. Voice is currently unavailable.

Under **Transfer Hub**, first close all chat tabs for a consistent snapshot. **Export · light** includes Hub cards/pages/assets, planning files, Context, Knowledge, Processes, Inbox, project registry, Hub skill folders and scope settings, portable preferences, Mr. Mik History and saved screens. It does **not** include native CLI transcripts, so a chat may not resume on another computer. **Export · full** additionally transfers supported OpenCode V1/V2 contexts/families and copies available native Codex and Claude transcripts associated with Mr. Mik History, plus available Claude sidecars and session-ID-specific task lists, file checkpoints, uploads and legacy image-cache files. It excludes native login/settings, shared caches, debug/environment state and temporary CLI scratchpads/images outside the Hub. It does not discover and export unrelated CLI conversations.

Import previews file counts and the state of each native chat. Relink **every linked project** to an existing folder on the destination computer; those external folders are not copied. Existing local folder mappings are suggested first, and your explicit folder choice takes precedence. Codex resumes with the mapped working folder, without rewriting its transcript or changing its user home.

**Updating a second computer:** close the chats on both computers (including any external CLI using the same conversation), export **full** on computer 1 and import on computer 2. A chat is identified by agent and native session ID, not its title. The importer compares transcript contents, not timestamps:

- **New conversation:** import the transcript and its Mr. Mik History entry/saved screen.
- **Continuation:** when the local transcript is a complete, byte-for-byte prefix of the archive transcript, update automatically. Back up the old transcript, History and screen first.
- **Identical:** do not copy the transcript again. A more recently updated Mr. Mik History entry and screen may be refreshed. The existing local History ID is retained, even if the archive uses a different Mr. Mik ID for the same native conversation.
- **Local continuation:** the archive is an older prefix of the local transcript. Keep the local conversation, History and screen; never downgrade them.
- **Divergent:** neither transcript continues the other, or Claude companion data conflicts. Keep the local branch by default. **Replace** explicitly accepts the archive branch and its History/screen, with a backup. This does **not** merge two branches or preserve both as a resumable conversation. Extra local Claude sidecars are retained; changed incoming sidecars are backed up before replacement.

For example, importing messages A/B/C onto a computer that has A/B updates to A/B/C. Importing A/B onto A/B/C does nothing. Importing A/B/D onto A/B/C requires a replacement decision for Codex/Claude; OpenCode keeps the local branch without a replacement option. This is a manual snapshot transfer, not continuous synchronization. Formats that rewrite earlier JSONL records are conservatively treated as conflicts even when the archive appears newer. A light archive cannot establish transcript ancestry, so it adds missing History entries/screens but does not automatically update existing ones.

Replacement backups live under the destination Hub's `.mrmak/import-backups/<timestamp>/`: `native/<agent>/<id>.jsonl`, Claude companion files, and `state/sessions.json`/saved screens where applicable. They are recovery files, not an automatic undo button. Keep them private and restore them only with the app and affected CLI closed. An existing Claude transcript keeps its native location even when you relink its working folder. Mr. Mik resumes the verified absolute transcript path in the mapped folder; it does not move or duplicate the transcript. Multiple files with the same native ID prevent transferring/resuming that native context until the ambiguity is resolved; explicit transfer exclusion can preserve other healthy conversations. Older CLI versions may need updating to support the current resume flags.

Hub file conflicts are kept by default unless selected for replacement. Cards, resource metadata and Inbox assignments merge by ID; skill-scope configuration files follow the file-conflict choice, so review that entry when combining two populated Hubs. **Restore app preferences** is an explicit option, off by default. It may restore Codex permission and other-agent bypass defaults, so inspect them before checking the box. It may restore the selected workspace when that ID exists in the destination registry; it never restores open chat/window selection or credentials. Different native conversations claiming the same Mr. Mik History ID are rejected rather than mixed.

The archive excludes linked external project contents and their `.codex`/`.claude` files, personal Codex/Claude/OpenCode/Kimi configuration, CLI installations, logins, secrets, runtime caches and local tool-visibility choices. Mr. Mik-owned private Claude MCP definitions also require review/recreation on the destination. Project-relative technical-document links and card artifact links work only after their external folders and referenced files are relinked. A full archive can contain sensitive conversation text and Hub documents even though credential files are filtered: store and share it carefully. Import does not install CLIs, authorize accounts, trust Codex projects or validate live MCP connections. The accent choice travels only with portable preferences and is applied on import only if **Restore app preferences** is selected.

## Where things live and what to verify

Hub cards and page references live in `workspace/workspace.json`; page files and media live under `workspace/`. Workspace identities are in `projects/registry.json`, and Hub skill switches in `projects/skill-scopes.json`. Shared files are under `context/`, `knowledge/`, `processes/` and `inbox/`. The Hub's `.mrmak/` folder holds machine-local state such as chat History/screens, Inbox assignments and linked-folder paths. Native CLI transcripts live in each agent's own user area, not in the linked project. Linked folders keep their own instructions, native skills and MCP configuration.

After importing on another computer, check: linked-folder paths; a sample card and its media; Knowledge/Processes and Inbox associations; Hub skill overrides for each agent you use; a new chat's working folder; native History resume for one exported chat; and Tools configuration in a *new* trusted chat. Re-enter account sign-ins and any MCP credentials separately. If a chat cannot resume, a missing native transcript or changed CLI environment is more likely than a missing Hub card. If a tool shows **Enabled** but does not connect, verify its executable/server, authentication, project trust and in-chat status.

## Data map and safety boundaries

This section is a reference for auditing or transferring a Hub. Paths below are relative to the selected Hub folder unless stated otherwise.

| Location | Purpose | Important limit |
| --- | --- | --- |
| `workspace/workspace.json` and `workspace/` | Card registration, page files and media | A card can contain several pages and assets |
| `projects/registry.json` | Workspace identities and linked-project descriptions | The external folder itself is not inside this file |
| `.mrmak/project-locations.json` | This computer's external folder mappings | Relink on a different computer |
| `projects/skill-scopes.json` | Hub skill global/workspace switches | Separate Codex, Claude and OpenCode decisions |
| `.agents/skills/` and `.claude/skills/` | Hub skill files | Different from native skills in external folders |
| `context/`, `knowledge/`, `processes/`, `inbox/` | Organizational library files | Inbox assignment may be metadata rather than a physical move |
| `.mrmak/` | Machine-local app settings, History/screens and caches | Export includes only selected portable data |
| External linked folder | Real Unity, Blender or other working project | Never copied merely by registering or exporting a Hub |
| External `.codex/config.toml` | Native Codex project settings, including selected MCP/plugin overrides | Written only after an explicit project-tooling action |
| Agent's user directory | Native agent conversations and personal configuration | Codex/Claude transcripts or OpenCode database, separate from Mr. Mik History and Hub files |

The Workspace Bridge is attached to eligible Codex, Claude and OpenCode workspace chats at launch. It can expose card operations, relevant Hub library documents, short Hub skill descriptions and linked-folder locations on request. It does not copy the Hub into the external folder, grant special access to all files, replace native project instructions or make Processes run in the background. The CLI's own trust, sandbox and OS permissions still govern what the agent can do.

Mr. Mik normally leaves external project folders untouched. The exceptions are explicit actions you choose: creating a native linked-project skill, saving a native MCP/plugin override, editing a file while deliberately browsing an external Root, or opening an external tool to work there. Be particularly careful with **Move to Recycle Bin** in Browse files; unlike removing a Hub link, it acts on the selected physical file.

## Troubleshooting by symptom

| Symptom | What to check first | What not to assume |
| --- | --- | --- |
| New chat opens in the wrong folder | Workspace, optional card and **Working project** in the New chat dialog; the card's linked folder for a shortcut | Switching the workspace selector will not redirect that chat |
| Linked project appears missing | Does the folder still exist at the recorded path? Relink it under Workspaces or during import | Git or a `.codex` directory is not required merely to link a folder |
| Card files appear separate from project files | Check **Files → Main folders** for Hub data and **Browse files → Root** for external data | A card association does not move files into the external project |
| Clipboard image is Unassigned | Check the chat's workspace association at paste time, then the visible workspace fallback | The current UI selector is not always the chat's own association |
| Hub skill is not used | Check agent tab, Hub On/Off, workspace Inherit/On/Off and whether the chat is new | Hub skills are not native `$`/slash-picker entries in linked folders |
| MCP shows Enabled but is unavailable | Check the server executable/URL, credentials, project trust and the agent's `/mcp` in a new chat | Enabled does not mean connected to an older chat |
| Tool entry cannot be toggled | Check its listed source and whether it is host/plugin-managed or a built-in component | Every installed tool does not have the same global/project controls |
| History will not resume | Check the native session ID, agent account, native transcript files and linked-folder mapping | A saved terminal screen cannot rebuild a lost native conversation |
| Card media or technical link breaks after import | Check that Hub media was imported and external referenced files were copied/relinked separately | Full export still excludes external project folders |
| Accent looks different in one area | Check Settings → Appearance in both windows and whether the area is an authored card page or an Original-colours CLI terminal | Themes intentionally do not repaint independent content |

When reporting an issue, record the selected workspace, linked folder, agent, whether the chat was already running, the exact action and error text. This is safer than repeatedly changing global configuration to make one project work.

## Developer and maintainer reference

The installed app has a user interface and a local service. The interface under `src/` renders Workspace, Chats, the right rail and this Help document. The service under `desktop/service/` manages settings, project locations, chat terminals, native-session metadata, tools and transfer archives. `src-tauri/` contains the Windows desktop host. Cards and other Hub content are ordinary files; the app source and Hub content may share one repository in the template, but they serve different purposes.

This Help window reads `docs/user-guide.md` at build time. Top-level `##` headings become navigation sections, and the text is searchable offline. When changing a feature, update the matching section and any relevant examples rather than adding a vague note at the end. For installation/build prerequisites, see `docs/getting-started.md`; for the multi-folder model, see `docs/multi-project.md`; for the source layout, see `desktop/README.md`.

For a source build, use `Setup.ps1 -Mode Check` to inspect prerequisites, then `Setup.ps1 -Mode Desktop` to build the Windows installer. A browser preview is not equivalent to the desktop app: managed terminals and native file actions require the desktop host and local service. Do not restart a running app or terminate active agent chats merely to apply a new build; finish and verify the build, then restart at a time that does not interrupt work.
