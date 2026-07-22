import { execFileSync } from 'node:child_process';

// Optional: pin the Atlassian cloudId so a headless `claude -p` doesn't fall back to
// the wrong site when the MCP server has access to several.
export const JIRA_CLOUD_ID = () => process.env.AUTODEV_JIRA_CLOUD_ID || null;

// "CV-123", or a browse URL like https://…atlassian.net/browse/CV-123 — else null.
export function parseJiraRef(s) {
  const m = String(s ?? '').trim().match(/^(?:https?:\/\/[^\s/]+\/browse\/)?([A-Z][A-Z0-9]+-\d+)$/);
  return m ? m[1] : null;
}

const FETCH_PROMPT = (key, cloudId) => `Call the mcp__atlassian-jira__getJiraIssue tool for issue ${key}${cloudId ? ` with cloudId "${cloudId}"` : ''} (fields: summary, description, issuetype, priority). Then output ONLY a JSON object, no prose, no markdown fence:
{"key":"${key}","type":"<Bug|Story|Task|...>","summary":"...","description":"...(plain text, include acceptance criteria if present)"}
If the tool is unavailable or errors, output {"error":"<reason>"}.`;

// One-shot headless claude call through the already-OAuth'd atlassian-jira MCP.
// Read-only by construction: --allowedTools restricts the session to the single get tool.
export function fetchIssue(key) {
  const bin = process.env.AUTODEV_CLAUDE_BIN || 'claude';
  const prompt = FETCH_PROMPT(key, JIRA_CLOUD_ID());
  const args = process.env.AUTODEV_CLAUDE_BIN
    ? ['-p', prompt] // stub in tests
    : ['-p', prompt, '--allowedTools', 'mcp__atlassian-jira__getJiraIssue'];
  // A .js AUTODEV_CLAUDE_BIN (test stubs) runs via node — extensionless scripts can't spawn on Windows.
  const [file, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
  const out = execFileSync(file, argv, { encoding: 'utf8', timeout: 120_000 });
  const m = out.match(/\{[\s\S]*\}/); // strict-JSON ask, but tolerate surrounding chatter
  if (!m) throw new Error(`jira fetch returned no JSON for ${key}: ${out.slice(0, 200)}`);
  const issue = JSON.parse(m[0]);
  if (issue.error) throw new Error(`jira fetch failed for ${key}: ${issue.error} — if unauthenticated, run an interactive claude session and authenticate the atlassian-jira MCP server`);
  if (!issue.summary) throw new Error(`jira fetch for ${key} missing summary`);
  return {
    key,
    type: /bug/i.test(issue.type || '') ? 'bug' : 'feature',
    summary: String(issue.summary),
    requirement: `[${key}] ${issue.summary}\n\n${issue.description || ''}`.trim(),
  };
}
