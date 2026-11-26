# Third-party notices

The application and original workflow documentation use the root MIT license.
Third-party components retain their own licenses.

- Graphical Codex and Claude chats use Streamdown 2.7.1, `@streamdown/code`
  2.0.0, `@streamdown/math` 1.0.3 and `@streamdown/mermaid` 1.0.3 under
  Apache-2.0. Shiki, KaTeX and Mermaid retain their respective licenses.
  Frontend dependency license texts are included in
  `App/runtime/UI-DEPENDENCIES.txt` in portable distributions and in the runtime
  directory of installer builds. Source copies live in
  `desktop/licenses/UI-DEPENDENCIES.txt`.
  T3 Code is a design reference; this change does not copy its source code.

- Chat history virtualization uses `@tanstack/react-virtual` 3.14.24 under MIT.
  The adapter uses the application's existing scroll container; it does not
  include T3's application state or provider runtime. Its license is included
  in the frontend dependency notices above.

- `@anthropic-ai/claude-agent-sdk` 0.3.301 supplies local Claude history/fork
  helpers. Its README and applicable notices remain in the packaged dependency.
  Live Claude inference uses the separately installed native Claude Code CLI.

- The six optional game workflow skills are adapted from witnesstodark/mr-mak-workspace
  v0.4.15, commit f122637a26c584ae1d3e48470d11874517913748, under its MIT license.
  The original specialized workflows and VFX reference are retained, with Mr. Mik
  Hub/project scope guidance added. See docs/upstream-adaptations.md.

- `img2threejs` is bundled under Apache-2.0. Its license and notices are retained
  in `.agents/skills/img2threejs`. Source: https://github.com/img2threejs/img2threejs.
- JavaScript and Rust dependencies are recorded in their lockfiles. Their
  respective license files remain in the packaged dependency distributions.
- Codex, Claude Code, Kimi, Blender, Higgsfield, fal.ai and the referenced MCP
  servers are separate products. This template does not grant access to their
  accounts, models or services. Provider names and logos identify integrations.
- The Arachne and Mr. Mak 64 samples contain AI-generated concept images and motion studies
  shared by the repository creator as a learning example. You may copy and
  adapt these included assets with the template. Historical model labels describe
  the original studies, not a promise of current model availability or rights
  to third-party characters. The sample makes no exclusivity claim.
- Mr. Mak 64 also includes camera renders of the creator's Unity prototype scene.
  They document its appearance; no Unity project or playable build is bundled.
- The Mr. Mak photograph is supplied by the repository creator for this project.
  It may remain in forks and copies of the template.

This is an independent community project, not an official product of the
listed providers.

The Windows x64 application bundles OpenAI Codex 0.163.0 exclusively as the
graphical chat engine, under Apache-2.0. The existing terminal integration still
uses the user's separately installed CLI. The full license is retained in
`desktop/licenses/CODEX-APACHE-2.0.txt` and in the packaged runtime; native package
notices and resource manifests remain alongside the bundled dependencies.
Source: https://github.com/openai/codex/tree/rust-v0.163.0.

The development service runtime includes Microsoft Playwright MCP 0.0.83 and
its pinned Playwright/Playwright Core dependencies under Apache-2.0. Dependency
license files remain in their packaged npm distributions. Edge and Chrome are
separate installed products; their browser binaries are not bundled by this
integration. See [Playwright MCP](https://github.com/microsoft/playwright-mcp).
