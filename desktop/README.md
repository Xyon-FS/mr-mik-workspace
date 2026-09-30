# Desktop architecture

The Windows app is a Tauri 2 shell around two webviews. It starts one local Node
service, binds it to loopback and gives each window the authenticated local URL.
Workspace renders the React UI and report files. Chats renders real PTYs through
xterm.js. The windows share sessions and settings but minimize independently.

| Path | Responsibility |
| --- | --- |
| `src/` | React Workspace, document previews, files and chat UI |
| `desktop/service/` | HTTP/WebSocket service, PTYs, session history and tools |
| `src-tauri/src/` | Windows shell integration, taskbar identities, native drag and optional Win key |
| `workspace/workspace.json` | Card registry |
| `workspace/_shared/` | Report CSS, image viewer and Help |
| `.mrmak/` | Local runtime state; ignored by Git |

`npm run desktop:build` runs `desktop/prepare.mjs`, builds the React frontend,
packages the service with a Node executable and production dependencies, then
builds the Tauri executable and NSIS installer. The recipient selects their own
repository; its content is served from disk rather than baked into the installer.

The service runs CLIs as the current user. Their available files and permissions
follow their launch options and native account settings. Permission bypass is
off by default. Do not expose the local service as a public web server.

Voice is temporarily disabled; existing local transcripts are retained and the
service rejects new voice sessions. Routine actions call local tools;
the Codex app-server coordinator handles broader orchestration with the user's
configured model. Larger execution tasks go to visible worker terminals. The
provider's native conversation ID is recorded when available for later resume.

New Codex and Claude chats default to `xhigh`; explicit saved effort choices are
preserved. Terminal URLs and OSC 8 links use xterm link handlers. New-window
requests from both app windows open HTTP(S) links through the Windows default
browser association, while the current app view stays open.

Fullscreen Claude scrolls its own conversation. Terminal snapshots preserve
both mouse tracking and the requested SGR encoding, including saved screens,
so switching tabs or reconnecting does not disable its mouse wheel. Classic
Claude and Codex continue using local terminal scrollback.

## Checks

```powershell
npm ci
npm --prefix desktop/service ci
npm run lint
npm test
npm run test:template
npm run build
npm run desktop:test:ui
```

UI tests use an isolated repository and fake terminals. Edge must be available
on Windows, or set `MRMAK_TEST_BROWSER` to a Playwright browser channel you have
installed. Legacy live-voice and subscription smoke checks are separate scripts
with explicit opt-in flags; they are never part of the default test command.

Windows x64 is the validated native target. Porting the native shell integration
to another operating system requires additional work.
