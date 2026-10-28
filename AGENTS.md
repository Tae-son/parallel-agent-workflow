# Agent instructions

Several agents work in this repository in parallel; one owner merges. Read `CONTRIBUTING.md`
before changing anything. It is the rulebook, and it wins wherever this file is shorter.

- Work on your own branch in your own worktree, inside the Allowed paths of your brief.
- Change files listed in `scripts/gate-files.txt` only when your brief says so.
- Run `npm run verify`, then open a pull request filled in from
  `.github/pull_request_template.md`. Your task ends at the pull request.
- Never merge, push to `main`, push with `--force` (`--force-with-lease` on your own branch
  only), or run `scripts/land.sh`, `scripts/codex-review.sh` or `codex`.
- For the step-by-step procedure and when to stop and ask, use the `parallel-agent-workflow`
  skill (`.claude/skills/` for Claude Code, `.agents/skills/` for Codex).
