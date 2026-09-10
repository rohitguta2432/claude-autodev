# 004 — Direct push, auth preflight, serialised deploys

## Why

Run #9 (ordertable, SCRUM-75) took 86 minutes of wall clock for 17 minutes of work. The
difference was parks, none of them about the change:

1. Three identical sessions failed with `Failed to authenticate: OAuth session expired`,
   and the park reason (and the Jira comment) was the CLI's JSON result object — usage
   counters with the one readable sentence buried inside.
2. `gh pr merge --rebase` failed with `This branch can't be rebased` because main had moved
   under the open pull request. The fix was a local rebase and force-push by hand.
3. The Push stage spent a Sonnet session to run three git commands.

The repo's rule is "commit on main and deploy in the same session"; the pull request was
ceremony the pipeline paid for and the operator never read.

## Requirements

- **FR-001** `.autodev.json` `pushMode: "direct"` makes stage 5 runner-owned: fetch the base
  branch, rebase the run's branch onto it, push the branch with `--force-with-lease`. No
  session, no pull request, `pr_url` stays null. A `pushed` event records the commit.
- **FR-002** In direct mode stage 8 lands the branch itself: rebase onto the base tip again
  (tests ran on the branch; main may have moved) and `git push origin HEAD:<base>`. A
  `merged` event records the commit and says `fast-forward, pushMode direct`. Idempotent:
  a HEAD already contained in the base branch is recorded, not pushed again.
- **FR-003** A rebase conflict in either stage aborts the rebase (worktree unchanged),
  parks the run as final, and names the branch to resolve on.
- **FR-004** `baseBranch` names the landing branch; default is `origin/HEAD`, else `main`.
- **FR-005** Before the first stage the runner asks `claude auth status`. `loggedIn: false`
  parks the run with the sign-in remedy and spends no session. A CLI that lacks the
  subcommand or answers unparseably changes nothing (fail open).
- **FR-006** A `--output-format json` result line in session output is reported by its
  `result` text in park reasons, blocked.md and ticket comments — never by the object.
  `Failed to authenticate` / `OAuth session expired` classify as `not-authenticated`.
- **FR-007** Stage 8 runs under a per-repository lock (`~/.autodev/locks/deploy-<hash>`),
  so parallel runs of one repo never deploy concurrently. A lock whose owner pid is dead is
  reclaimed; waiting longer than the stage timeout parks.
- **FR-008** The proof report shows `Pushed: <commit> on <branch>, rebased onto origin/<base>`
  in place of the pull request line when no PR exists and a `pushed` event does.

## Deliberately not done

- Squash on landing. Direct mode keeps the run's commits as the builder made them; the
  operator's repo already asks for conventional commits per task.
- Auth preflight for stub CLIs in the test suite: stubs answer `auth status` like an old
  CLI (exit 1, no JSON) and are ignored, so no existing test counts an extra session.
