# Mr. Mik application development

Read [AGENTS.md](AGENTS.md) for source development, verification, privacy and
temporary-test cleanup rules. These instructions are not distributed to user
Hubs. Their separate Claude instructions live in templates/hub/CLAUDE.md.

Complete distributed skills are available in `.claude/skills/`, including their
scripts and references. `.agents/skills/` is the maintained source shared with
Codex. Edit that source and run `npm run skills:sync` for a change intended for
both agents. Do not modify native user skill/configuration folders for source
changes or isolated tests.
