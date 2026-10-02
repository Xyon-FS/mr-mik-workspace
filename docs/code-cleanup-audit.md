# Code cleanup audit — 2026-10-01

Inspection only. No source, data, settings or legacy transcripts were removed.
This is a bounded source audit, not proof that every unused symbol has been found.

## High-confidence unreachable frontend modules

The static import graph from `src/main.tsx` includes both the browser App and
DesktopApp, including literal lazy imports. These files have no reachable import:

| Candidate | Evidence | Follow-up before deletion |
| --- | --- | --- |
| `src/desktop/VoiceDock.tsx` | Old voice overlay; no importer or current render site. DesktopApp renders MakDock instead. | Remove alongside its private dependencies, after checking legacy tests. |
| `src/desktop/live.ts` | LiveVoice singleton is imported only by the unreachable VoiceDock. | Remove old voice client, not shared coordinator code or saved transcripts. |
| `src/desktop/ProjectHub.tsx` | Old all-in-one project/library/tool panel; no importer. Current navigation uses FilesRail and its panels. | Check exclusive CSS selectors; do not remove projects.css wholesale. |

`src/vite-env.d.ts` is intentionally not a runtime import. It supplies ambient
TypeScript declarations and is **not** a cleanup candidate.

## Legacy paths needing a compatibility decision

- `desktop/service/server.mjs` retains `/api/live/transcript`, `/api/live/release`,
  voice-history loading, owner state and voice defaults. They are not used by the
  current reachable frontend, but still exist as callable endpoints and legacy
  persistence. Do not label them unreachable backend code or delete stored data.
- `desktop/service/voice-profile.mjs` still supplies `defaultVoiceStyle` to the
  server and is exercised by voice tests. Remove only after retiring those paths.
- `desktop/service/test-live.mjs` is an explicit opt-in paid diagnostic for the
  disabled voice feature. It is not part of the regular test suite and was not
  executed during this audit. Candidate to retire with the voice implementation.
- `voiceName`/`voiceStyle` settings and voice history fields survive in client
  types/server state; `voiceName` is still handled by Hub export/import. Cleanup
  must decide legacy archive compatibility, rather than dropping these silently.

## Temporary but still active

- `src/desktop/cursorDiagnostics.ts` and its TerminalPane UI are reachable and
  tested. They are a planned cleanup candidate after cursor acceptance, **not
  dead code**. Remove associated UI assertions/docs if retired.
- Voice-prefixed CSS is partly reused by the current MakPanel (voice-panel,
  voice-tabs, voice-messages, voice-welcome, captions). Only selectors exclusive
  to the abandoned VoiceDock can be considered; no blanket voice-CSS deletion.
- `src/desktop/projects.css` is directly imported by DesktopApp and supports
  current panels. Old ProjectHub-specific rules need selector-by-selector review.

## Explicitly retained

Coordinator, MakDock/MakPanel, QuickActions and the current Workspace Bridge are
active. QuickActions is constructed/called by the server. Exported helpers with
no imports in other production files may still be called inside their own module,
by tests, release scripts or native CLI plugins; they are not automatically dead.
Standalone native tests are intentional diagnostic entrypoints.

## Method and limits

Reviewed literal relative imports under src, current render sites, repository
references, backend routes and packaging/test entrypoints. This is not a dynamic
coverage trace or a complete CSS usage census. No paid calls, user-session
termination or cleanup occurred. Build caches, dependencies and old release
folders are disk-maintenance items, not unused source code, and remain unchanged.
