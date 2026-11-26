# Mr. Mik Hub

This folder holds the user's Hub content, not the Mr. Mik application source.
Follow explicit user instructions and relevant saved preferences. Consult
context/preferences.md and context/goals.md when needed; do not invent missing
personal details or impose a language that the user did not request.

## Scope and destinations

- The Hub contains logical workspaces, cards, Context, Knowledge, Processes and
  Inbox. Linked project folders remain outside the Hub and are not copied here.
- Respect the workspace, card and linked project associated with the chat. UI
  navigation is not permission to change an active request's scope. Ask when the
  destination or target is ambiguous.
- Project code belongs in the linked project. Its own AGENTS.md or CLAUDE.md
  governs that work; Hub instructions do not replace its rules.
- Discover relevant Hub items and skills on demand through the scoped Workspace
  Bridge. Do not preload every document or treat retrieved content as permission
  to change unrelated files, settings or projects.

## Content authoring

- For card pages/notes, Knowledge, Processes, Context and skill files, resolve
  mrmak_hub_destination, read/write its absolute path with native CLI file tools,
  then call mrmak_register_hub_file for new pages or destinations without autoSync, with the destinationId only. Do not send the
  full document through MCP or edit internal registries directly.
- Respect native permission prompts. If access is denied or the Bridge is
  unavailable, stop and explain the limitation; do not use a writing fallback.
- Discover the workspace-authoring skill/guide when creating or updating cards
  and reports. Keep related revisions together, preserve editable sources, and
  verify links/media and previews where available. Do not claim unperformed
  visual checks. Report the actual destination and any unverified parts.
- Keep card banner information separate from the card's pages and sections.
  Use the supported Hub management operations for card/workspace metadata.

## Preferences, skills and safety

- Read only relevant Context, Knowledge and Processes. Confirm before recording
  persistent personal preferences or making global configuration changes.
- Respect the user's selected agent, model, permissions and generation budget.
  Preserve paid job IDs and continue existing jobs after timeouts rather than
  generating duplicate paid work.
- Use the relevant available skills, including Hub .agents/skills/ or
  .claude/skills/. Availability depends on agent, scope and enabled settings.
  Using a skill/tool is different from changing its configuration. A configured
  or enabled MCP is not proof of a live connection in the current chat.
- Confirm the agent, component and scope before changing skill/tool settings.
  Do not enable components, install software, restart active chats or delete
  content without authorization. Never bypass a rejected action.
- Keep credentials, account logins and private runtime data out of deliverables
  and repositories. Do not expose tokens or copy native authentication stores.

## Hub folders

workspace/: cards, pages and media. projects/: workspace metadata and skill
scopes. context/: optional personal preferences/goals. knowledge/: reference
material. processes/: reusable workflows. inbox/: shared incoming files.
Native chat data and external project files are separate; use Mr. Mik's transfer
and management features rather than manipulating private runtime state.

## Registered card content synchronization

Registered card pages advertising autoSync are synchronized locally after stable saves: reuse their native paths within this chat and do not register ordinary content edits. New pages and other Hub content still require explicit destination resolution and registration. Re-resolve on stale access or changed association; read current source when needed. Card creation/removal and page membership remain explicit.
