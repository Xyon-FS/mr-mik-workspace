# Getting started with Mr. Mik

Mr. Mik is an independently maintained fork of Mr. Mak by witnesstodark. Keep application source, personal Hub content and linked external project folders conceptually separate. A Hub must contain `workspace/workspace.json`; external projects do not need Git. This distribution starts without cards, personal projects, account logins or History.

## Ready-to-use Windows packages

The installer bundles the local Node service and production interface. Install for the current Windows user; WebView2 is installed by the bootstrapper when necessary. Then launch Mr. Mik and choose a Hub folder. Installing the app does not include or authenticate any agent CLI.

Alternatively extract the portable ZIP and double-click **Start Mr. Mik.cmd**. It opens the included clean `Hub` folder. The neighboring executable can also be started directly to select/remember an existing Hub. Portable bundles the runtime but is not profile-isolated: native agent authentication/transcripts and Windows preferences remain in their normal user profiles. WebView2 must already be installed.

To reuse an existing Mr. Mak Hub, choose that folder explicitly. The legacy `.mrmak` state remains supported. Do not run Mr. Mak and Mr. Mik against the same Hub concurrently. Native CLI authentication/global tools are not copied or moved. Prefer a full private Hub archive into a separate Hub when testing migration.

## Connect an agent and create your first workspace

Install/sign in to the agent you intend to use with its official setup instructions: [Codex CLI](https://developers.openai.com/codex/cli) or [Claude Code](https://code.claude.com/docs/en/setup). Accounts are required for model chat, not source builds or browsing files. Shell remains a local terminal option. No voice/API account is required; the old voice feature is disabled.

1. Open **Workspaces** in the right rail.
2. Add a workspace name and pick its first external project folder using **Browse**. Add additional named linked folders (Unity, Blender, etc.) as needed.
3. Create a card for a work area, optionally associate it with a linked project, and add pages/media through the Bridge or file controls. Several cards may share the same linked folder.
4. Use a card's Codex/Claude shortcut for a preassociated chat, or Chats **+** for explicit configuration. A planning card works in the Hub rather than silently choosing an unrelated external folder.
5. Ask, for example: “Create a planning page in the current Mr. Mik card.” Hub organizational content goes through the Workspace Bridge, while source-code work belongs in the linked project's working folder.

Use **Help** for the complete offline manual. It covers cards, scope selection, skill/tool configuration, native model/reasoning capabilities, coordinator actions, History, archive/delete and storage. Provider/account/CLI limitations still apply. A configured MCP is not proof it is connected in an existing chat.

## Source development

Required: Windows x64, Node 22.20+ with npm, stable Rust, Visual Studio C++ tools, Windows SDK and WebView2. An agent account is not required to compile.

```powershell
npm ci
npm run lint
npm test
npm run test:template
npm run build
npm run desktop:build
npm run release:package
npm run release:verify
```

Root `npm ci` installs the service dependencies too. `desktop:build` prepares runtime/UI and produces the NSIS installer. Packaging writes ignored `release/<version>/` artifacts and checksums without installing or publishing them. Bump the app version before producing another distributable release; packaging refuses to overwrite existing releases.

For development use `npm run desktop:dev`. For report-only browser preview use `npm run dev` (creates a `public/workspace` junction); it does not start managed desktop terminals. `Setup.ps1 -Mode Check`, `Preview` and `Desktop` provide the corresponding diagnostic/setup routes without automatically installing global tools.

## Another computer or Git

Use **Settings → Transfer Hub → Export full** for private transfer of managed native conversations/History. Light export omits native transcripts. Use **Workspace snapshot · Git** for one workspace's content-only snapshot, with previewed update/import and external-folder relinking. Neither transfers authentication or copies external folders. See [transfer documentation](workspace-snapshots.md).

To publish application source, use `npm run source:clean -- <new folder>` and review the output. Personal data and generated caches/targets are excluded by allowlist; source fixtures and skill text still require human review. Installer/portable belong in release assets, not Git-tracked source. The artifact workflow is manual and does not publish automatically.
