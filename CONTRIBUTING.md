# Contributing

This repository uses pull requests as the acceptance boundary. `main` is the approved
baseline, not an agent workspace. One human, the owner, merges; agents never do.

> [!IMPORTANT]
> If GitHub branch protection or rulesets are not enabled for this repository (for example
> on a plan where private repositories cannot use them), every rule below is procedural, not
> a technical security boundary. Enable protection when you can; until then the hooks and
> the gate catch accidents and ordinary attempts, not a determined bypass.

## One task, one branch

Use a short branch name that describes one outcome:

- `feat/<scope>` for new user-facing behaviour
- `fix/<scope>` for defects
- `content/<scope>` for copy or sourced-data updates
- `chore/<scope>` for tooling and repository maintenance

Start from the latest baseline:

```bash
git switch main
git pull --ff-only
git switch -c feat/example-scope
```

A separate Git worktree is preferred when an agent is doing the work:

```bash
git fetch origin
git worktree add ../example-scope -b feat/example-scope origin/main
```

Point one agent session at that worktree. Give it one bounded assignment with explicit
acceptance checks. Do not authorise direct work on `main`, deployment, merging or unrelated
cleanup.

## Parallel agents

Several agents may work at once. These rules keep them from breaking each other's work or
`main`.

**The owner assigns, agents follow.** Each task starts from an owner-written brief that names
its scope and **Allowed paths**. User-facing changes need the brief approved before any
building starts. Start the brief with the skill's name, `/parallel-agent-workflow` in Claude
Code or `$parallel-agent-workflow` in Codex, so the agent always loads the step-by-step
procedure rather than relying on it to load by itself:

```text
/parallel-agent-workflow
Scope: …
Allowed paths: …
Acceptance: …
```

**Before starting**, the agent:

1. Works in its own fresh worktree and branch from a freshly fetched `origin/main`. If the
   worktree it was handed is not a clean new branch from current `main`, or is another task's
   in-flight branch, it stops and asks.
2. Runs `scripts/agents-status.sh` and `gh pr list`, then compares its Allowed paths with
   other worktrees' committed, uncommitted and untracked files and with open pull requests.
   On any overlap, behaviour conflict or unclear ownership, it stops and asks instead of
   guessing.

**While working**, the agent:

- edits only its Allowed paths, and never another task's worktree, branch or uncommitted
  files;
- does not edit gate files unless the brief says so. These are the files that define the
  checks, the merge gate or the build: tests, QA and scripts, CI and hooks, agent
  instructions, this file, package manifests and build config. `scripts/gate-files.txt` is
  the single list, and both `land.sh` and the Codex review read it from `main`;
- regenerates lockfiles instead of hand-merging them;
- checks that a dev-server port is answered by its own process before trusting what it
  serves;
- uses `--force-with-lease` only on its own branch, never `--force`.

**Before pushing**, it rebases on the latest `origin/main`, reruns `npm run verify`, and
opens a pull request using the template. It never merges and never runs `scripts/land.sh`
or Codex. A Claude Code `PreToolUse` hook (`.claude/hooks/agent-guard.mjs`) blocks the
common forms of those commands. Like the pre-push hook, it catches accidents and ordinary
attempts; it is not a security boundary.

**Work-in-progress limit:** at most three active agent branches. Unfinished worktrees are a
bigger risk than concurrency, so finish or close work before starting more.

## Local push guard

Enable the version-controlled Git hook once in each clone:

```bash
git config core.hooksPath .githooks
```

The pre-push hook inspects every destination ref and blocks any push to `refs/heads/main`,
including a refspec such as `other-ref:main`. Push the task branch and merge through a
reviewed pull request instead.

This is a local safety rail, not a security boundary: hooks can be bypassed or omitted in
another clone. For a genuine emergency only, the explicit one-command override is:

```bash
ALLOW_MAIN_PUSH=1 git push <remote> <refspec>
```

Any override must be deliberate, documented and followed by read-back of the remote `main`
commit.

## Acceptance check

Before pushing:

```bash
npm ci
npm run verify
git status --short
git diff origin/main...HEAD
```

For visible changes, also run the project locally and inspect the affected screens or
outputs. Attach useful before/after screenshots to the pull request.

## Pull request

Push only the task branch:

```bash
git push -u origin feat/example-scope
gh pr create --base main --fill
```

A pull request is ready to merge only when:

1. The task is within the stated scope.
2. The complete diff has been reviewed.
3. `npm run verify` and GitHub CI pass.
4. Visible changes have been inspected, not merely compiled.
5. Claims, figures, external links and licences have evidence.
6. No credentials, private notes, generated dependencies or unrelated files are present.
7. The owner accepts the result.

## Merge and cleanup

Use **Squash and merge** for normal task branches so `main` keeps one clear commit per
accepted change. Do not merge because an agent says the work is done; merge because the
evidence passes.

The owner merges from the primary checkout of `main`, in their own terminal:

```bash
scripts/land.sh 7            # or: scripts/land.sh --codex 7
```

`land.sh` runs nothing from the pull request locally; the Codex review and the pattern lists
it uses come from `main`'s exact commit, not from the working tree. It refuses unless
GitHub's `CI / verify` check passed on the exact head commit, the branch contains the latest
`main`, and the pull request targets `main`. It also refuses symlink or submodule changes.
It prints a review packet showing paths outside the declared scope, gate-file diffs in full,
and a preview link for UI changes. It merges only after the owner types the PR number at the
terminal, plus `gate` or `preview checked` when those apply. Immediately before merging, it
re-checks that neither the head nor `main` has moved.

Two limits matter:

- The gate protects only merges that go through it. Without branch protection, GitHub does
  not stop a merge made from its web page.
- **Bootstrap:** `land.sh` runs only if it is byte-identical to the copy on GitHub's `main`.
  The pull request that first adds it must therefore be reviewed and merged by the owner in
  GitHub's web interface. Later changes to `land.sh` go through the current gate as gate
  files. After merging one, run `git pull --ff-only` on `main` before the next landing.

`--codex` adds an optional second opinion from Codex on risky files. You see each payload
before it is sent and approve each send separately. Findings can hold a merge until you
classify or override them; Codex finding nothing is never treated as approval. Run your own
trial (see `docs/design.md`) before relying on it.

After merging:

```bash
git switch main
git pull --ff-only
git branch -d feat/example-scope
git worktree remove ../example-scope  # when a worktree was used
```

## Deployment

Merging a pull request does not by itself publish anything unless you have connected a
deployment integration. If you connect one, the human-controlled merge to `main` becomes the
production-publication gate: the person merging authorises that deployment. Treat connecting
the integration as a publication decision, verify that production points to the merge commit
after each landing, and keep the preceding successful deployment as the rollback target.
