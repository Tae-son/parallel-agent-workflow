---
name: parallel-agent-workflow
description: Use for implementation, independent QA, or resuming a task ending in a verified pull request. Parallel agents work on branches and one owner merges; walks the task from brief through QA to owner acceptance. Not for general read-only questions or exploration.
---

# Parallel agent workflow

`CONTRIBUTING.md` is the rulebook; this skill only sequences it. Read its "Parallel agents"
section before step 1. Where the two ever disagree, `CONTRIBUTING.md` wins.

Native guard setup and coverage are documented in `docs/agent-support.md`. Claude,
Codex and Hermes share command policy, not identical execution-path coverage.
Verify activation on the actual runtime; do not silently enable plugins or trust hooks.
Hermes can read this file directly when it is not registered in its skill catalogue.

**Always, at every step:**

- The owner merges. Never merge, push to `main`, push with `--force` (only
  `--force-with-lease`, on your own branch), or run `scripts/land.sh`,
  `scripts/codex-review.sh` or `codex`.
- Edit only the brief's Allowed paths, in your own worktree and branch.
- Gate files (`scripts/gate-files.txt`) only when the brief says so.
- When a stop condition below holds, stop and ask the owner instead of guessing.

## 0. Resume (only if the task is already under way)

- **Inputs:** your branch and worktree.
- **Do:** `git log --oneline origin/main..HEAD`, `git status --short`, and
  `gh pr view --json number,state,body,headRefOid` if a pull request exists. Recover the brief
  and Allowed paths from the PR body or the owner's message.
  Check the active QA report against the head SHA; a new commit needs fresh QA.
- **Output:** the step to continue from.
- **Stop if:** you cannot find the brief, the branch is not yours, or the PR is merged or
  closed.

## 1. Brief

- **Inputs:** the owner's message.
- **Do:** identify the scope, the Allowed paths, the acceptance checks, and whether gate
  files are in scope.
- **Output:** the brief, quoted, kept for the pull request body.
- **Stop if:** there is no owner brief, or a user-facing change has no approved brief. If the
  owner's message names no Allowed paths, propose them and wait for the owner to confirm
  before step 2; do not infer them and carry on.

## 2. Preflight

- **Inputs:** the brief; `CONTRIBUTING.md` "Before starting".
- **Do:** make sure you are in a fresh worktree on a new branch from freshly fetched
  `origin/main`. Run `scripts/agents-status.sh --fetch` and `gh pr list`. Compare your
  Allowed paths with every other worktree's committed, dirty and untracked paths and with
  open pull requests, and consider whether their changes could conflict with yours in
  behaviour even where the paths differ.
- **Output:** "no overlap", or the overlap or conflict found.
- **Stop if:** the worktree is not clean and new, any overlap, behaviour conflict or unclear
  ownership appears, or `agents-status.sh` warns that the work-in-progress limit is
  exceeded.

## 3. Build

- **Inputs:** the brief; `CONTRIBUTING.md` "While working".
- **Do:** make the change inside the Allowed paths only. Regenerate lockfiles instead of
  merging them by hand. Before trusting a dev server, check that its port belongs to your
  own process.
- **Output:** commits on your branch.
- **Stop if:** the change needs a path outside the Allowed paths, or a gate file the brief
  did not name.

## 4. Verify

- **Inputs:** your commits; `CONTRIBUTING.md` "Acceptance check".
- **Do:** `git fetch origin` and rebase on `origin/main`, then run `npm ci`, `npm run verify`,
  `git status --short` and `git diff origin/main...HEAD`. For visible changes, run the
  project and inspect the affected screens.
- **Output:** passing checks and a diff you have read in full.
- **Stop if:** a check fails and the fix is outside the brief, or the diff contains paths
  outside the Allowed paths.

## 5. Pull request

- **Inputs:** the verified branch; `.github/pull_request_template.md`.
- **Do:** push only your branch (`git push -u origin <branch>`; `--force-with-lease` on your
  own branch only). Fill in a copy of the template outside the repository, then
  `gh pr create --base main --title "<title>" --body-file <that file>`. Copy the brief into
  `Approved brief:` and the Allowed paths into `Allowed paths:`, because `scripts/land.sh`
  reads both. List any gate files you changed.
- **Output:** the pull request URL and a BLOCKED QA placeholder, ready for step 6.

## 6. Independent QA

- **Inputs:** approved brief and acceptance criteria, Allowed paths, PR URL, exact head
  commit, and prior findings. Follow `CONTRIBUTING.md` "Independent QA" for the report format.
- **Do:** arrange a separate QA agent/session with a clean checkout of that exact commit.
  QA inspects the full diff, runs verification, and tests criteria and failure cases without
  editing the implementation. Supply real observations, commands and limitations in the
  single `independent-qa` JSON block under `## Independent QA` in the PR body. Record distinct
  builder/reviewer session IDs. Never author your own QA approval; an orchestrator may
  transcribe the separate session's report unchanged. Read back the published body and SHA.
- **On FAIL or BLOCKED:** the builder fixes within scope, reruns verification and pushes;
  QA must retest the new head and replace the report. Preserve prior findings in comments or
  linked session records. Every new commit invalidates the previous QA, including rebases.
- **Stop if:** independent QA cannot run, required access is missing, a fix needs unapproved
  paths, or two fix/retest rounds leave blockers. Report the blocker to the owner, not PASS.
- **Output:** a verified PR with independent PASS evidence and honest current CI status.
- **Then stop.** The owner accepts the evidence and runs `scripts/land.sh`; agents never
  merge. Declared session IDs are not authentication, and green CI alone is not QA.

If this skill did not load on its own, invoke it by name (`/parallel-agent-workflow` in
Claude Code).
