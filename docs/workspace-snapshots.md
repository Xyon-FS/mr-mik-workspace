# Workspace snapshots and private archives

## Choose the right format

**Workspace snapshot**: an ordinary folder suited to user-controlled Git, representing exactly one logical workspace. It includes card files, shared report styles, workspace Knowledge/Processes, associated Inbox files and project-effective Codex/Claude Hub skills. It records linked folder names/IDs but never their machine paths or contents. Global Context, global Knowledge/Processes, chats, coordinator conversations, native auth/configuration, tool definitions and Windows preferences are excluded.

**Full Hub archive**: a private machine-transfer backup of the Hub and its managed History, including available native Codex/Claude conversations. **Light Hub archive** omits native transcripts but still contains History/screens and potentially private material. These archives are not intended as public Git repositories. Unmanaged CLI conversations are not automatically swept into the export.

## Export one workspace

Select the workspace in the right sidebar, open Settings, and find **Workspace snapshot · Git**. Click **Export workspace**, then choose a folder outside the Hub. A new uniquely named folder is created. Nothing is written into linked projects.

`mik-workspace.json` contains format `mr-mik-workspace`, schema `1`, app version, stable workspace/card/resource/linked-project IDs, relative paths, exported time and SHA-256/size per file. Its content is readable JSON; this is not a runnable application or a CLI session backup. `skills/codex` and `skills/claude` hold copies of effective Hub skills, not native linked-project skills. Global skill settings and other workspace scopes are omitted.

Review the folder before committing. Create/push your Git repository using your normal Git workflow; the application does not initialize, stage, commit, push or authenticate Git for you. Native MCP definitions often contain private values and are deliberately omitted. Configure those separately on the destination computer.

## Update an existing snapshot

Choose **Update snapshot** and select a previously exported folder of the same workspace. The preview shows changed/new files and files removed from the current manifest. Confirm to replace the snapshot. Only files named in the previous manifest can be removed; unrelated files and `.git` are retained. Original bytes are copied to `.mik-backups/<operation-id>` before writes; that directory is ignored by the generated `.gitignore`.

If you edited managed content directly in the snapshot, checksums no longer match: import/update refuses it. Edit in the Hub and export again, or restore the checked snapshot revision. This first format is a validated Hub-to-Git snapshot workflow, not a free-form Git editing synchronization engine.

## Import or update a Hub

Click **Import snapshot**, select its folder and review the preview. Stable IDs avoid duplicated workspaces/cards. An existing workspace's metadata can be replaced only after explicit confirmation. Different file contents are conflicts; confirm each replacement, or cancel. No partial mixed workspace is imported when conflicts remain unresolved. Shared report styles or Hub skill definitions are identified by their file paths and may affect other workspaces if replaced.

Use **Relink folder** next to Unity, Blender, etc. to pick the destination machine's existing external folders. Blank means keep a local link when available, otherwise leave it unavailable. Import never clones/copies external projects. Relink later through Workspaces before opening a linked-project chat. Cards without linked projects remain Hub/planning cards.

Content and metadata replacement is backed up under the Hub's `.mrmak/snapshot-backups`; failure rolls back written files. Removed cards/resources are removed from this workspace's metadata, not permanently deleted from disk. Source files still present on disk may reappear as unregistered/global content; review them manually before cleanup. Other workspaces are retained. Imports and snapshot updates require worker chats to be closed and coordinator work to finish.

## Migration and limits

Old full/light Hub archives remain compatible: this feature adds a separate format rather than changing their transcript merge rules. Native chat/auth/config locations remain unchanged. The legacy `.mrmak` internal folder is retained intentionally.

Snapshots are explicit copies, not continuous synchronization or a three-way merge. They do not preserve History, tool visibility preferences, runtime state, active terminals, global settings or source application files. Use full private Hub archive transfer when moving conversation state between computers. Do not run two app instances against the same Hub.
