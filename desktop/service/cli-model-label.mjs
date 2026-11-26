// Display metadata only: never use terminal text to change launch settings.
export function cliModelLabel(screen, agent) {
  let lines = screen.split('\n').map(line => line.trim());
  const startup = lines.findLastIndex(line => agent === 'claude' ? /\bClaude Code v\d+\./.test(line) : /\bOpenAI Codex\b/.test(line));
  if (startup >= 0) lines = lines.slice(startup);
  if (agent === 'codex') {
    const notice = lines.findLast(line => /^Model changed to [a-z0-9][a-z0-9._-]*\s+(?:low|medium|high|xhigh|minimal|none)\b/i.test(line.replace(/^[•●]\s*/, '')));
    if (notice) return /Model changed to ([a-z0-9][a-z0-9._-]*)/i.exec(notice)[1];
    // Native startup and /status panels label this explicitly.
    for (const line of lines) {
      const match = /^[│┃]?\s*model:\s*([a-z0-9][a-z0-9._-]*)\b/i.exec(line);
      if (match) return match[1];
    }
  }
  if (agent === 'claude') {
    const notice = lines.findLast(line => /^(?:[•●]\s*)?Set model to\s+\S/i.test(line));
    if (notice) return notice.replace(/^(?:[•●]\s*)?Set model to\s+/i, '').replace(/\s+(?:for this session only|with .* effort).*$/i, '').trim();
    for (const line of lines) {
      const match = /^[│┃\u2580-\u259f\s]*((?:Sonnet|Opus|Haiku|Fable)(?:\s+\d+(?:\.\d+)*)?(?:\s*\([^)]*\))?|claude-[a-z0-9._-]+)\s*[·•|]/i.exec(line);
      if (match) return match[1];
    }
    // The native catalog may introduce a new family before the app updates.
    // Accept its caption only beside an actual versioned startup banner.
    const banner = lines.findIndex(line => /\bClaude Code v\d+\./.test(line));
    if (banner >= 0) for (const line of lines.slice(banner + 1, banner + 4)) {
      const match = /^[│┃\u2580-\u259f\s]*([a-z][a-z0-9 ._()-]{1,100}?)\s+[·•]\s+(?:Claude\b|API Usage Billing\b)/i.exec(line);
      if (match) return match[1].trim();
    }
  }
  return null;
}
