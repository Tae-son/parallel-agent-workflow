# Agent instructions

Several agents work in this repository in parallel; one owner merges. Read `CONTRIBUTING.md`
before changing anything. It is the rulebook, and it wins wherever this file is shorter.

- Work on your own branch in your own worktree, inside the Allowed paths of your brief.
- Change files listed in `scripts/gate-files.txt` only when your brief says so.
- Run `npm run verify`, then open a pull request filled in from
  `.github/pull_request_template.md`. Obtain independent QA from a separate session,
  resolve failures and have QA retest the exact final commit before owner acceptance.
  Never write your own QA approval. Your task ends at the verified pull request, not a merge.
- Never merge, push to `main`, push with `--force` (`--force-with-lease` on your own branch
  only), or run `scripts/land.sh` or `scripts/codex-review.sh`. Do not run `codex` directly.
  Agents may run Codex smoke tests only when the owner explicitly approves the exact test
  and its isolation boundaries, and only through `scripts/codex-smoke.sh`. This exception
  does not relax owner-only merging, sandbox or hook-trust requirements, live-profile
  controls, or the prohibitions above.
- For the step-by-step procedure and when to stop and ask, use the `parallel-agent-workflow`
  skill (`.claude/skills/` for Claude Code, `.agents/skills/` for Codex; Hermes can read the
  latter file directly). See `docs/agent-support.md` for native guard activation and gaps.
  Installed files do not prove an active guard. Report missing activation; do not grant
  hook trust or change live profiles without owner approval.
