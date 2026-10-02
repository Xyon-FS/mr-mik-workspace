# Mr. Mik

Work with your AI agents. Keep the project, its files and what you learn in one place.

Mr. Mik is a local Windows app with two connected windows: **native AI chats on the left**, and **your project workspace on the right**. Work with Codex, Claude Code or OpenCode in your existing folders, then keep plans, explanations, references and results in cards you can return to.

It is the little brother of [Mr. Mak Workspace](https://github.com/witnesstodark/mr-mak-workspace), created by **witnesstodark**. This is an independently maintained, MIT-licensed derivative, not an official upstream release or an OpenAI/Anthropic product.

![Mr. Mik overview: Marketing, Unity and Blender cards alongside workspace management](overview.png)

## What would I use it for?

Suppose you are making a game. Your Unity project, Blender files and marketing material live in different folders. Your conversations explain the work, but useful details become hard to find as the chats grow.

Create a workspace called **Game X**, link those folders and add cards such as **Unity development**, **3D characters** and **Marketing**. A card is a collection, not just an HTML page: it can hold notes, images, videos, documents and a small HTML site your agent builds for you.

Open a chat from the Unity card to work on the actual project. Afterwards, ask the agent to put an explanation in that card or save a lesson in Knowledge. Your code stays in its original folder; the organizational content stays in Mr. Mik. The same approach works for research, writing, design or any project combining conversations and files. Git is optional.

Mr. Mik does **not** replace the agents, provide a model subscription or automatically install every tool. It runs your installed CLIs and gives their work a place to live.

## Download and first launch

**Windows x64** is the supported desktop platform. Get ready-to-use packages from [Releases](https://github.com/Xyon-FS/mr-mik-workspace/releases). You do not need to clone or build this repository to use them.

### Portable — the simplest first start

1. Download the `windows-x64_portable.zip` asset and extract it to a writable folder. Do not run it from inside the ZIP.
2. Double-click **Start Mr. Mik.cmd**. The included **MyHub** opens with example content.
3. Browse **Mik’s Midnight Workshop**: four example cards for a fictional espresso-delivery game, with offline pages and a local illustration. No agent login is needed to explore them.
4. When ready, archive the examples and create your own workspace, or keep them for reference.

The portable contains **App/** (program and bundled runtime) and **MyHub/** (content and hidden state folders). Windows WebView2 must be installed. Native agent logins/conversations still use their normal Windows profile locations: portable does not mean fully profile-isolated.

### Installer

Download the `windows-x64_setup.exe` asset, install it and launch **Mr. Mik**. It bundles the local runtime and can install WebView2 when needed; it does not install the agent CLIs.

On first launch, choose **Create a new Hub** or **Open an existing Hub**. Creation prepares `Documents/Mr. Mik/MyHub` with starter examples and skills; you can choose another parent folder instead. Existing folders are never overwritten. Opening uses a prepared Mr. Mik/Mr. Mak Hub containing `workspace/workspace.json`, without importing or copying it. Your selection is remembered. An ordinary Unity/Blender/code folder is a *linked project*, not the Hub to select here. To restore an exported archive, create/open a Hub first, then use **Settings → Transfer Hub → Import**.

**Beta 0.2.10:** keep backups, especially before transfers and removal actions. Not every clean Windows installation or provider setup has been validated.

## Connect your agent

Install and configure at least one agent separately: [Codex CLI](https://developers.openai.com/codex/cli), [Claude Code](https://code.claude.com/docs/en/setup) or [OpenCode](https://opencode.ai/docs/).

Mr. Mik uses the CLI's existing authentication. Subscription/API access depends on the agent and provider; normal access rules and usage limits apply. Accounts are not bundled and credentials are not stored in your Hub.

Use **Settings → Accounts** to inspect local connection status and open native sign-in/sign-out. OpenCode lists connected providers under one heading; the **+** icon (Connect provider) opens provider setup. Finish authentication in the native terminal/browser, not a model conversation. Changes affect the shared CLI profile on this PC; close that agent's Mr. Mik chats before switching accounts. A green status does not guarantee subscription validity or access to every model.

Browsing Hub content does not require a login. The text-based **Mik coordinator** specifically requires Codex; ordinary Claude/OpenCode chats do not.

## Create your first project

Four names describe the structure:

- **Hub:** your overall collection of workspaces, shared content and settings.
- **Workspace:** one logical project, such as Game X.
- **Linked project:** an actual working folder, such as Unity or Blender. It does not need Git.
- **Card:** a work area inside a workspace. It can be associated with a linked project but need not be; several cards can share one linked project.

Start here:

1. Open **Workspaces** in the right rail and add a workspace. Link your first project folder if you have one; planning-only workspaces can start without one.
2. Add other folders under **Linked projects**. Registration records their paths; it does not copy or move them.
3. Create a card, choose its type and optionally associate it with a linked project.
4. Use the card's agent **+** shortcut for a chat already associated with the card and working folder. Use **+** in Chats when you want to configure a chat yourself.
5. Ask the agent to work on the project, or create content in Mr. Mik.

For example:

> Implement the inventory feature in the linked Unity project. Then create an HTML explanation in the current Mr. Mik card, and save any reusable lessons in this workspace's Knowledge.

The chat's **working folder** is where project work happens. The **Workspace Bridge** gives supported chats access to their associated Hub, card and workspace even when the terminal works in an external folder. Explicitly asking for “the current Mr. Mik card” makes the destination clear. A card without a linked project opens a planning chat in the Hub, not an unrelated folder.

The Bridge supplies compact orientation and retrieves relevant content on demand; it does not preload every card, skill or file. Agents still need to choose appropriate tools and native permissions apply. Review important changes rather than assuming every request was routed correctly.

## Working day to day

**Keep useful results, not just conversations.** Put explanations and references inside cards. Use **Knowledge** for reusable lessons, **Processes** for repeatable workflows and **Inbox** for incoming material. Clipboard images saved through the app use the selected workspace association. Browse files, preview media or use file context menus for Explorer and Recycle Bin actions.

**Return to chats.** History keeps Mr. Mik's managed conversations, with pinning, archive/restore and supported native resume. Removing an entry from Mr. Mik differs from deleting its native conversation; permanent deletion is separately confirmed. Native chats can also appear in the agent's own application because they use its normal storage. Empty chats are omitted from useful History.

**Ask Mik to organize the work.** The small mascot opens a persistent text coordinator. It can inspect the selected workspace, manage cards/shared content and coordinate worker chats. Select the intended scope before sending. Mik uses Codex and retains native conversation references; its New conversation/Fork controls are separate from worker chats. Voice conversation is disabled.

**Choose skills and tools deliberately.** In **Skills**, enable shared Hub skills globally or override them for a workspace. Native linked-project skill files are separate and follow each agent's discovery rules. New Hubs enable `workspace-authoring` and `feature-handoff` for Codex, Claude and OpenCode; other included workflows start Off. Existing explicit choices are preserved. A skill guides relevant requests; enabling it does not execute it automatically.

In **Tools**, inspect/configure supported MCPs for the agent and linked project. Requested native configuration changes can write to that project's settings. **Configured is not the same as connected in this chat.** Supported changes refresh affected chats; busy chats, drafts or native dialogs may require a manual action or safe resume. Host-managed tools/plugin controls differ by platform. See [Help](docs/user-guide.md) for exact scopes and limits.

## Keep your work when updating or changing PCs

**Portable update on the same PC:** back up your Hub, close Mr. Mik and replace only **App** and **Start Mr. Mik.cmd**. Keep your existing **MyHub**, including hidden folders. Never overwrite it with the example MyHub from a new ZIP. The launcher also supports older `Hub/` folders and an external Hub path as its first argument.

**Installer update:** install the newer version and retain your existing Hub. Content is separate from the program. Back up before updating; an app update is not a substitute for a backup.

**Another PC or recovery after formatting:** use **Settings → Transfer Hub**:

- **Full export** includes Hub files/configuration, managed History and supported native conversation contexts. Review unavailable contexts and external attachments explicitly; excluding an unavailable context does not discard healthy ones.
- **Light export** keeps Hub content and Mr. Mik History/screens without native transcripts. It cannot restore the original model conversation by itself.

Import previews show conflicts and folder relinking. Newer/divergent local contexts are protected; unavailable incoming copies do not overwrite healthy local chats. Native authentication, agent-global configuration and external project folders are **not included**: restore those folders and configure/sign in to agents separately on the destination PC. Full archives can contain private conversations/files; do not publish them in public Git repositories.

For content-only Git sharing, use **Workspace snapshot · Git**. Snapshots preserve workspace content/associations, not native chats or authentication; Mr. Mik does not automatically commit or push. See [transfer documentation](docs/workspace-snapshots.md).

## Agent support and limits

**Codex, Claude Code and OpenCode V1/V2** have dedicated integrations for associated chats, the Bridge, skills/tools and native conversation handling. Their interfaces differ: model, reasoning/variant, fork, plugin and transfer capabilities are not identical. Later CLI releases are not blocked solely by version number; required native contracts are checked, and upstream changes may require adapter updates.

OpenCode transfer supports standalone chats and bounded same-folder families with reviewed attachments, continuation/conflict protection and controlled deletion. Cross-folder families, unsupported dependencies and unsafe references remain guarded. See [OpenCode integration](docs/opencode-integration.md) for V1/V2 differences and limits. Provider setup determines which models you can actually use.

**Kimi** has limited terminal/History support, not full Bridge, skill/tool control, native fork/deletion or conversation-transfer parity. Current CLI compatibility is not validated. **PowerShell** is an ordinary local shell for commands/builds, not an AI agent; saved screens do not restore running processes.

## Mr. Mak and Mr. Mik

Mr. Mak already supplies the foundation: native chats beside visual cards/files, shared folders, skills, MCP visibility, History and optional coordination. Mr. Mik does not claim to have invented those capabilities.

This version organizes work as a **Hub with multiple logical workspaces**, each linking several external folders and containing multiple cards. It adds scoped Hub management through chats, a persistent text coordinator, App/MyHub portable updates and reviewed transfer/snapshot workflows. Voice is disabled. Neither app requires every card to be a Git repository.

Upstream evolves independently. Changes are reviewed/adapted manually, not automatically merged. The [adaptation ledger](docs/upstream-adaptations.md) records what was brought across; [CHANGELOG](CHANGELOG.md) records this application's changes.

## Documentation and source development

In-app **Help** opens the detailed offline manual. See the [user guide](docs/user-guide.md), [getting started](docs/getting-started.md), [multi-project model](docs/multi-project.md) and [security notes](SECURITY.md).

To build on Windows x64, install Node **22.20+**, npm, stable Rust, Visual Studio C++ Build Tools, Windows SDK and WebView2, then run:

```powershell
npm ci
npm run lint
npm test
npm run test:template
npm run desktop:build
npm run release:package
npm run release:verify
```

Desktop build prepares the production UI/runtime. Packaging writes ignored `release/<version>/` installer/portable assets and checksums without installing/publishing them; it refuses to overwrite existing releases. `npm run desktop:dev` runs the native development app; `npm run dev` is a report/browser preview, not a managed-terminal replacement.

Keep personal Hub data separate from application source. Dependencies, caches, frontend output, Rust targets and release bundles are generated/ignored. `npm run source:clean -- C:\Path\To\NewSourceFolder` creates an allowlisted source copy with empty Hub metadata; review it for private content before sharing. Legacy `.mrmak` state names remain for compatibility.

Evaluate migration from Mr. Mak on a backed-up separate Hub copy. Do not run both apps against the same Hub simultaneously. Mr. Mik has a separate application identifier/install name; compatibility with every upstream data version is not guaranteed.

## Acknowledgements

A heartfelt thank you to [**witnesstodark**](https://github.com/witnesstodark) for creating and sharing [**Mr. Mak Workspace**](https://github.com/witnesstodark/mr-mak-workspace). Mr. Mik exists because of that foundation. The original MIT license/copyright are preserved in [LICENSE](LICENSE); bundled third-party materials retain their notices in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).

---

Mr. Mik, the little brother.

<img src="docs/assets/mr-mik.png" width="260" alt="Mr. Mik, a pink spotted pig wearing a newsboy cap">
