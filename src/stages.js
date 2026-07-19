import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export function findSpecDir(worktree) {
  const root = join(worktree, 'specs');
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter(d => /^\d{3}-/.test(d) && statSync(join(root, d)).isDirectory()).sort();
  return dirs.length ? join(root, dirs.at(-1)) : null;
}

export function isCompleteSpecDir(dir) {
  return ['spec.md', 'plan.md', 'tasks.md'].every(f => {
    const p = join(dir, f);
    return existsSync(p) && statSync(p).size > 0;
  });
}

const STOPWORDS = new Set(['with', 'from', 'that', 'this', 'into', 'when', 'the', 'and', 'for', 'add']);
const slugWords = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-')
  .filter(w => w.length >= 4 && !STOPWORDS.has(w));

// Finds the single specs/NNN-* dir that's both complete and a word-overlap match for
// requirement. Null on no match or ambiguous (multiple) matches — stage 1's session
// adjudicates ambiguity itself rather than us guessing.
export function specDirFor(repoPath, requirement) {
  const root = join(repoPath, 'specs');
  if (!existsSync(root)) return null;
  const words = slugWords(requirement);
  if (!words.length) return null;
  const dirs = readdirSync(root).filter(d => /^\d{3}-/.test(d) && statSync(join(root, d)).isDirectory());
  const matches = dirs.filter(d => {
    const slugTokens = d.replace(/^\d{3}-/, '').split('-');
    return words.some(w => slugTokens.includes(w)) && isCompleteSpecDir(join(root, d));
  });
  return matches.length === 1 ? join(root, matches[0]) : null;
}

export function detectTestCmd(dir) {
  const has = (f) => existsSync(join(dir, f));
  if (has('package.json')) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.scripts?.test) return has('pnpm-lock.yaml') ? 'pnpm test' : 'npm test --silent';
  }
  if (has('pytest.ini') || has('pyproject.toml')) return 'pytest -q';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test -q';
  return null; // ponytail: unknown stacks pass with a warning event; add detectors when hit
}

const git = (wt, cmd) => execSync(`git ${cmd}`, { cwd: wt, encoding: 'utf8' });
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const specFile = (run, f) => {
  const d = findSpecDir(run.worktree);
  need(d, 'no specs/NNN-* directory found');
  return join(d, f);
};

export const STAGES = [
  {
    n: 1, key: 'spec', title: 'Spec',
    prompt: (run) => `First check specs/ for an existing spec set covering this requirement. If a complete one exists (spec.md, plan.md, tasks.md), adopt it and do not create a duplicate; if one exists but is incomplete, complete the missing documents in place. Only create a brand-new specs/NNN-slug/ set if nothing matches. Requirement: ${run.requirement}\nUse the specs-skill skill if it is installed; otherwise create a GitHub Spec Kit document set yourself: specs/NNN-slug/ containing spec.md (user scenarios, functional requirements, success criteria), plan.md (technical approach), research.md (decisions & rationale), data-model.md (entities/schema), quickstart.md (run & verify steps), contracts/ (API/interface specs), tasks.md (ordered checkbox tasks \`- [ ] T001 ...\`), and checklists/ (quality gates) as appropriate.`,
    check: (run) => {
      for (const f of ['spec.md', 'plan.md', 'tasks.md']) {
        const p = specFile(run, f);
        need(existsSync(p) && statSync(p).size > 0, `spec artifact missing or empty: ${f}`);
      }
    },
  },
  {
    n: 2, key: 'analyze', title: 'Analyze',
    prompt: (run) => `Open the newest specs/NNN-* folder. Work through every checklist under its checklists/ directory: verify each item against spec.md, plan.md and tasks.md, fix the documents where they fall short, and tick each checklist item (- [x]) once satisfied. Do not leave any gating item unchecked.`,
    check: (run) => {
      const dir = join(findSpecDir(run.worktree) ?? '', 'checklists');
      if (!existsSync(dir)) return; // no checklists → nothing gates
      for (const f of readdirSync(dir)) {
        need(!/^- \[ \]/m.test(readFileSync(join(dir, f), 'utf8')), `unchecked items remain in checklists/${f}`);
      }
    },
  },
  {
    n: 3, key: 'implement', title: 'Implement',
    prompt: (run) => `Use the executing-plans skill if it is installed; otherwise implement the newest specs/NNN-*/tasks.md in this repository yourself, task by task, test-driven, committing after each task and ticking each task checkbox (- [x] T###) in tasks.md as you complete it. All tests must pass before you finish.`,
    check: (run) => {
      const tasks = readFileSync(specFile(run, 'tasks.md'), 'utf8');
      const un = tasks.match(/^- \[ \] (T\d+)/m);
      need(!un, `unchecked task remains: ${un?.[1]}`);
      need(git(run.worktree, 'status --porcelain').trim() === '', 'uncommitted changes in worktree');
    },
  },
  {
    n: 4, key: 'push', title: 'Push',
    prompt: (run) => `Use the ce-commit-push-pr skill if it is installed; otherwise: ensure all work on the current branch (${run.branch}) is committed with clear conventional-commit messages, push the branch to the remote with upstream tracking (git push -u), and open a pull request with \`gh pr create\` (or equivalent). Write the PR URL (just the URL) to .autodev/pr-url in the repo root.`,
    check: (run) => {
      try { git(run.worktree, 'rev-parse --abbrev-ref @{u}'); }
      catch { throw new Error('branch has no upstream — push failed'); }
    },
  },
  {
    n: 5, key: 'review', title: 'Review', // runner drives the review⇄fix loop; this is one review round's prompt
    prompt: (run) => `Use the code-review skill at high effort if installed; otherwise rigorously self-review all changes on this branch relative to the default branch for correctness, security, and data-loss risk. Then write your verdict as JSON to .autodev/review.json in the repo root: {"verdict":"APPROVE"|"REQUEST_CHANGES","findings":[{"file":"...","summary":"...","severity":"..."}]}. APPROVE only if no correctness, security, or data-loss findings remain.`,
    fixPrompt: (run, findings) => `A code review of this branch produced these findings that must be fixed:\n${JSON.stringify(findings, null, 2)}\nFix every finding, keep tests green, and commit the fixes.`,
    check: (run) => {
      const p = join(run.worktree, '.autodev/review.json');
      need(existsSync(p), 'review.json not written by review session');
      const { verdict } = JSON.parse(readFileSync(p, 'utf8'));
      need(verdict === 'APPROVE', `review verdict: ${verdict}`);
    },
  },
  {
    n: 6, key: 'test', title: 'Test', // runner executes detectTestCmd itself; claude only summoned to fix failures
    prompt: (run) => `The test suite is failing. Read .autodev/test-output.txt. Use the systematic-debugging skill if it is installed; otherwise debug methodically yourself: reproduce, isolate, find the root cause, fix it, and commit. Never weaken or delete tests to make them pass.`,
    check: (run) => { /* runner sets run._testsPassed after executing the test command */
      need(run._testsPassed, 'test command exited non-zero');
    },
  },
];
