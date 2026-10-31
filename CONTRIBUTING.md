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
building starts.

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
or `scripts/codex-review.sh`. It does not run Codex except for the narrow smoke-test
exception below. A Claude Code `PreToolUse` hook (`.claude/hooks/agent-guard.mjs`) blocks
the common forms of those commands. Like the pre-push hook, it catches accidents and
ordinary attempts; it is not a security boundary.

Codex also has a native synchronous `PreToolUse` registration in `.codex/hooks.json`;
Hermes has a native `pre_tool_call` plugin in `.hermes/plugins/parallel-agent-guard/`.
Both reuse the unchanged Claude command checker, but neither is activated merely by
installing the kit. Codex needs project and exact-hook trust; Hermes needs explicit
plugin enablement on the actual CLI/ACP/gateway surface. Follow
[`docs/agent-support.md`](docs/agent-support.md) for version references, activation checks,
and limitations, notably terminal stdin and effective working-directory differences.
Never grant trust, install into a live profile or disable additional execution tools
without separate owner approval. These integrations do not weaken independent QA or
authorise any agent to merge.

**Owner-approved Codex smoke exception.** Agents may run Codex smoke tests only when the
owner explicitly approves the exact test and its isolation boundaries. They must use
`scripts/codex-smoke.sh`; direct `codex` invocation remains prohibited. The runner requires
a marked disposable root, a clean standalone Git repository with no remotes, isolated
`HOME` and `CODEX_HOME`, a harmless `gh` stub and a scrubbed child environment. It refuses
known sandbox-bypass flags. Its `--owner-approved` declaration is procedural evidence, not
authenticated consent, so the owner's written approval remains the authority.

This exception does not authorise merging, pushing to `main`, force-pushing, running
`scripts/land.sh` or `scripts/codex-review.sh`, changing normal profiles or live T3 settings,
granting project/hook trust outside the approved disposable boundary, bypassing sandbox
controls, installing dependencies, or making a paid model call without separate owner
approval. Fixture tests may use a harmless Codex stub. Report those results separately from
native activation, and treat the actual CLI/ACP route as unverified until an approved native
test observes it.

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
7. Independent QA reports PASS with evidence on the exact head commit and no blockers.
8. The owner accepts the result.

## Independent QA

Every PR needs a separate QA agent/session after the builder's local verification and PR
creation. A different model is optional; a separate session and independent testing are not.
The builder or orchestrator arranges that session. If it cannot, report BLOCKED to the owner;
do not silently replace it with self-review or the optional `--codex` opinion.

Give QA the approved brief, acceptance criteria, Allowed paths, PR URL, exact head SHA and
prior findings. QA reads the full diff and relevant code, derives tests from the brief rather
than trusting the builder's summary, runs `npm run verify`, and exercises relevant behavior
and failure cases. Visible changes need actual screen/output inspection. Use a clean checkout
of the exact PR head, with no uncommitted implementation changes. QA is read-only with
respect to the implementation; scratch probes and test artifacts stay outside tracked files.
Do not run untrusted PR code with production credentials or access. Never run the owner-only
merge/review scripts against a real repository; the kit's hermetic test fixtures are permitted.

QA supplies one report using the `independent-qa` JSON block in the PR template. Put it under
`## Independent QA` in the **PR body**, not in a commit, checkbox or unselected comment.
The QA session may publish it, or the orchestrator may transcribe its report without changing
the findings. Read back the published body and head SHA to verify the update. Preserve prior
rounds in PR comments or linked session records, not extra active report blocks.

Report contract (version 1, no extra keys):

- `head`: the full lowercase 40-character reviewed commit SHA.
- `builder`, `reviewer`: distinct, traceable session/task identifiers. Use only letters,
  digits, `.`, `_`, `:`, `/`, `-`, starting with a letter or digit. These identify sessions,
  not GitHub accounts; never invent a reviewer identity.
- `verdict`: `PASS`, `FAIL` or `BLOCKED`.
- `checks`: a nonempty array of objects with `criterion`, `result` and `evidence`.
  Map every approved acceptance criterion to an observation. `result` uses the same three
  verdicts. Evidence includes the command or manual procedure and its observed result,
  with artifact/log links where useful. A test name or "looks good" alone is insufficient.
- `blockers`: an array listing unresolved blocking findings, with reproduction details.
- `limitations`: nonempty text stating untested boundaries and non-blocking risks, or an
  explicit statement that none were identified within scope.
- `version`: the number `1`.

Only PASS with every check PASS, no blockers, and all required evidence is ready for owner
acceptance. A demonstrated defect is FAIL; missing access, unavailable tools or an untested
required criterion is BLOCKED. A limitation must not hide a failed or untested requirement.
The builder fixes defects within the approved scope, reruns verification and pushes. **Every
new commit, including a rebase or documentation fix, invalidates QA.** QA must retest the
new head, carry forward prior findings, and replace the active report. Changed acceptance
criteria also need owner approval and fresh QA. Stop and ask if fixes need unapproved paths;
if two fix/retest rounds leave blockers unresolved, escalate instead of looping indefinitely.

`land.sh` checks the report's structure, distinct declared sessions, exact SHA and passing
results, and displays the evidence. It refuses missing, malformed, FAIL, BLOCKED or stale
reports and nonempty blockers. It re-reads the entire PR body before merging and refuses any
change during owner review, including withdrawal of QA or edits to the brief. Do not edit the
body while the owner lands it. This is a gate check, not automatic reviewer orchestration.

**Trust limit:** a shared GitHub account cannot prove which agent wrote a report. Session
IDs and evidence are declarations, not authentication. The gate cannot judge completeness
or truth of observations; the owner must inspect coverage and the separate session's record.
There is no atomic GitHub condition on PR metadata: a body edit after the final read can
still race the merge. `--match-head-commit` protects the code SHA, not the body. Web merges
can still bypass this local gate without suitable GitHub protection.

**Rollout:** existing open PRs need QA reports once this gate reaches `main`. The PR adding
this requirement is reviewed with the current gate on `main`; obtain independent QA for it
procedurally. After the owner merges, update the primary checkout before the next landing.

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
GitHub's `CI / verify` check and the independent QA report pass on the exact head commit,
the branch contains the latest `main`, and the pull request targets `main`. It also refuses
symlink or submodule changes.
It prints a review packet showing paths outside the declared scope, gate-file diffs in full,
and a preview link for UI changes. It merges only after the owner types the PR number at the
terminal, plus `gate` or `preview checked` when those apply. Immediately before merging, it
re-checks that neither the head nor `main` has moved and that the PR body is unchanged.

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
