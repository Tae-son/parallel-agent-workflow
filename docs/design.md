# Design and threat model

This kit answers one question: how can one human stay the only party that changes `main`
while several AI agents work in parallel, without reading every line of every tool call?

## Trust rules

1. **`main` is the approved baseline, not a workspace.** Agents never commit, merge, rebase
   or reset on `main`. They work in their own worktree on their own branch.
2. **The owner assigns, agents follow.** Every task starts from an owner-written brief that
   names the scope and the Allowed paths. The PR body carries both so the gate can show what
   fell outside them.
3. **The gate trusts only `main`'s exact commit on GitHub.** `land.sh` refuses to run unless
   it is byte-identical to `scripts/land.sh` at that commit and the primary worktree is
   checked out at it (so `.gitattributes` and friends are `main`'s too). Every git call runs
   with hooks disabled so that a branch tried out locally cannot execute code with the
   owner's credentials. It reads
   `gate-files.txt`, `ui-paths.txt`, `risky-paths.txt`, `codex-review.sh` and its siblings
   from that commit, never from the working tree or the PR. A PR therefore cannot weaken the
   rules that judge it; it can only propose a change that the current rules print in full.
4. **Typed confirmation on a real terminal.** Answers come only from `/dev/tty` (file
   descriptor 3); stdin is closed. Piping `yes` does nothing. The PR number must be typed,
   plus `gate` when gate files changed and `preview checked` when UI files changed.
5. **Re-check before the irreversible step.** After the owner confirms, the script re-reads
   the PR (head, state, draft flag, base branch, CI check and raw body) and `main`, refuses if
   anything changed, then merges with `--match-head-commit` so GitHub also refuses a race.
6. **Untrusted text is sanitised before it reaches the terminal.** PR titles, bodies and
   paths can carry terminal control sequences and bidirectional, zero-width or otherwise
   invisible characters (soft hyphen, word joiner, variation selectors, line separators).
   They are replaced with `?` so a PR cannot repaint the screen or disguise a path, and
   single-line fields lose embedded newlines so they cannot forge packet lines. Raw
   non-UTF-8 bytes are left alone because they are indistinguishable from UTF-8
   continuation bytes.
7. **Globs from the PR never expand against the filesystem.** `set -f` is on for the whole
   run; Allowed paths are matched with `[[ == ]]` only.
8. **Symlinks and submodules are refused outright.** Both are classic ways to smuggle content
   past path-based review.
9. **A silent second opinion is not an approval.** The Codex review is advisory. Findings
   default to actionable and block until the owner classifies them; a clean result is
   reported as "not an approval"; partial reviews must be accepted explicitly.

## Layers and what each one catches

| Layer | Catches | Does not catch |
| --- | --- | --- |
| Claude `PreToolUse` hook (`agent-guard.mjs`) | Ordinary and wrapped forms of `git push` to `main`, force-push, `gh pr merge`, `gh api` writes and GraphQL mutations, running `land.sh`, `codex`, or `codex-review.sh`, and commit/merge/rebase/reset on `main`. Works in bypass-permissions mode because it is a hook, not a permission rule. | Command words built at run time (`$(echo gh) pr merge`), git and gh aliases, scripts written to disk and then run, other languages' subprocess APIs, raw `curl` to the API, branch switches earlier in the same command, remote push refspec config. The full list is in the file header. |
| Git `pre-push` hook | Any push whose destination is `refs/heads/main`, including `other-ref:main`. | A clone that never set `core.hooksPath`, or `ALLOW_MAIN_PUSH=1`. |
| `land.sh` | Everything in the trust rules above, for merges that go through it. | A merge made in GitHub's web UI, or by someone with push rights ignoring the process. |
| GitHub branch protection or rulesets | Direct pushes and web merges, if your plan and visibility allow it. | Nothing this kit can add. |

The honest summary: the first three layers turn accidents and ordinary attempts into clear
refusals with a next step. Only the fourth is enforcement. The kit documents this instead
of implying otherwise.

## Why the bootstrap rule exists

`land.sh` checks itself against GitHub `main` before doing anything else. The first PR that
adds it cannot pass that check, so that one PR is merged by the owner in the web UI after
reading it. Every later change to `land.sh` is a gate-file change: it is printed in full and
needs the typed `gate` confirmation, then `git pull --ff-only` on `main` before the next run.

## Why the owner, not the agent, runs the gate

Agents are good at producing plausible completion reports. The gate therefore asks for
evidence it can check (CI on the exact head, the diff itself, the preview built from that
commit) and for a human decision at the terminal. The guard hook blocks agents from running
it so that a confident agent cannot approve its own work.

## Parallelism rules

- One task, one branch, one fresh worktree from a freshly fetched `origin/main`.
- `agents-status.sh` before starting: compare your Allowed paths with every other
  worktree's committed, dirty and untracked paths and with open PRs. Overlap means stop and
  ask.
- Work-in-progress limit of three active branches. Unfinished worktrees are a bigger risk
  than concurrency.
- Gate files are edited only when the brief says so. Lockfiles are regenerated, not
  hand-merged. A dev-server port is trusted only after checking it is your own process.
- `--force-with-lease` only on your own branch, never `--force`.

## Independent QA gate

Independent QA tests the outcome, not merely the diff. It is mandatory for every PR and
separate from the optional advisory Codex opinion below. A separate session receives the
approved brief, acceptance criteria, exact head and previous findings; the builder owns
fixes, and QA owns the verdict. The protocol lives in `CONTRIBUTING.md` and the matching
agent skills. No provider-specific launcher or new dependency is needed.

The active report is a single fenced `independent-qa` JSON object in the PR body. Keeping it
outside Git avoids the self-reference problem of committing evidence for a SHA that changes
when the evidence is committed. The gate checks version/schema, exact head, distinct declared
sessions, nonempty criterion/evidence entries, PASS results, no blockers and explicit
limitations. It prints the report as sanitised data, never executes it, and compares the
entire raw PR body on the final read so that neither evidence nor scope can be swapped while
the owner reviews. There is no override for a failing or missing QA report.

This validates declarations, not actual independence or complete coverage. Sessions may
share a GitHub account; requiring different GitHub authors would exclude legitimate use
without proving independent thought. The owner must inspect the session record and evidence.
JSON is parsed by jq (including its duplicate-key semantics); use unique keys. The parser
requires exact fence lines, not a general Markdown document. The owner must also check
rendering and content, not mistake valid JSON for true observations.

GitHub provides no atomic comparison of PR body with merge: edits after the last read can
still race. `--match-head-commit` binds only code. Freeze PR-body edits during landing; use
GitHub protection for bypass resistance. These limits are disclosed rather than described
as an authenticated QA service. The first PR adding QA lands under the old trusted gate,
with independent QA performed procedurally; subsequent PRs use the new gate from `main`.

The report rules live in one jq module, `scripts/independent-qa.jq`. `land.sh` reads it with
`git show` from main's exact commit into its own temporary directory, so a PR (or a dirty
working tree) that loosens the rules is still judged by main's copy and shows up as a gate
diff. A main without the module, or with one that does not compile, refuses. `install.sh`
installs the module because `land.sh` needs it.

### Visible `independent-qa` commit status (kit repository only)

`.github/workflows/independent-qa.yml` makes the same structural verdict visible on the PR.
On `pull_request_target` (opened, edited, synchronize, reopened, ready_for_review, base
`main`) it checks out the default branch with the pinned `actions/checkout` and no persisted
credentials, and runs `scripts/independent-qa-status.sh OWNER/NAME PR#` with `GH_TOKEN` from
`github.token` only. Permissions are `{}` at the top and `contents: read`,
`pull-requests: read`, `statuses: write` for the one five-minute job. The job never checks out,
builds or runs PR code, downloads artifacts, uses caches or interpolates PR text into a shell.
The job's own check (`publish-status`) attaches to the base commit; the result the PR shows is
the separate commit status `independent-qa` that the runner posts on the PR's head SHA.

The runner ignores the event payload and re-reads the PR from the API. It validates the
repository, PR number and lowercase 40-hex head, posts `pending`, evaluates
`qa_report | qa_pass($head)` from the module beside it (plus open and base `main`), re-reads
the PR, and posts `success` or `failure` only if head, body, state and base are unchanged.
Otherwise it exits nonzero and leaves `pending`; the event for the change runs it again.
Descriptions are fixed strings, so PR text never reaches a status, argv or the log. API, JSON
or jq errors exit nonzero and never publish a new success. Concurrency is one group per PR
with `cancel-in-progress: false`: GitHub keeps one running and at most one pending run, a
newer pending run can replace an older one, and order is not guaranteed, which is why every
run reads current API data rather than trusting that each edit is processed.

Limits of this status, which is visibility, not a security boundary:

- It is structural evidence validation, not authentication or proof that the testing
  happened, and not an atomic barrier: the body can change after the final read. `land.sh`
  still re-reads the whole body and remains the owner's gate; it does not consult the status.
- A cached `success` can outlive its basis. If posting `pending` fails (an API outage) or the
  event for a body edit is delayed or dropped, an earlier `success` on that SHA stays until a
  later run replaces it. This job cannot revoke an old status during an outage.
- A commit status belongs to a SHA and context, not to a PR. Two PRs with the same head share
  one `independent-qa` status, last writer wins, and any token or workflow with
  `statuses: write` (including another same-repository workflow) can post a structurally
  plausible status under the same context. Pinning the status to the GitHub Actions app in
  branch protection narrows this but does not remove same-repository workflow forgery.
  Treat this stage as visibility until permissions are separated and protection is configured;
  credential separation and settings activation are separate owner tasks.
- Bootstrap: `pull_request_target` runs the workflow from the default branch, so it does
  nothing until it is on `main`; the PR that adds it cannot show its own status.
- GitHub announced that `pull_request_target` is blocked by default in public repositories
  from 2 December 2026 (brownout 16 November 2026, 16:00-18:00 UTC) unless an Actions event
  policy permits it
  ([changelog](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/),
  [guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)).
  Allowing it for this metadata-only workflow is an owner decision to take narrowly, after
  integration evidence from a disposable sandbox repository, not a blanket relaxation.
- Not yet tested against real GitHub (needs a separately approved disposable repository):
  status attachment to the head SHA, which edit and synchronize events actually fire,
  token behaviour for fork PRs, the identity GitHub records for the status, branch-protection
  enforcement of the context, and event-policy activation. The kit's tests use a fake `gh`
  and static workflow checks, which cannot prove GitHub's runtime behaviour.
- `install.sh` does not install the workflow or its runner: they need the owner's
  permission and policy decisions above for each repository.

## Optional cross-model review

`codex-review.sh` exists because a second model with a different training set catches a
different slice of mistakes. It is deliberately constrained:

- Only risky files go: `risky-paths.txt`, gate files, and files whose diff adds storage or
  network calls. `codex-exclude.txt` paths never go.
- Payload = fixed adversarial prompt + the PR's Scope and Allowed paths + your project
  contract + the unified diff, chunked to about 400 lines by module.
- The owner pages every payload and types `send N` for each chunk. No batch mode exists.
- Codex runs in an empty temporary directory, read-only sandbox, with tools disabled as far
  as the CLI allows. The script header records which flags were verified to take effect and
  which were not; it is mitigation, not containment.
- At most three reviewed heads per PR, then the owner decides without it.

Before relying on it, run your own trial: ten small patches, some seeded with defects and
some clean, identical payloads to two reviewers, raw outputs saved before scoring against a
fixed rubric. The original project prepared such a trial; its cases and answer key were
project-specific and are not included here.

## Decisions worth knowing

- **Squash merges.** One commit per accepted change keeps `main` readable and makes
  rollback a single revert.
- **Pattern lists live in files, read from `main`.** Hard-coding paths in the scripts made
  every project-specific change a gate change; files make the rules visible and reviewable
  while keeping the trust property.
- **The repository is detected from `origin`.** The private version hard-coded it; detection
  removes the most common adoption mistake. `--repo` still exists for cross-repository use
  and is shown prominently.
- **No package dependencies.** Bash, GNU userland, Git, `jq`, `gh` and Node only, so the
  gate works on any Linux machine the owner has and nothing in `node_modules` can alter it.
- **Fetching from the target, not blindly from `origin`.** When `origin` is a different
  GitHub repository (a fork or a mirror) and `--repo` or `LAND_REPO` names the target, PR
  objects are fetched from the target's own URL so the SHAs being judged are the right ones.
- **Unexpected Codex exit codes fail closed.** Only exit 2 ("did not run") lets the merge
  continue with a visible note; a crashing or misconfigured `codex-review.sh` refuses.

## Accepted limitations

- The preview link is any successful deployment status on the head commit. A workflow in
  the same repository could create one with a lookalike URL; the owner must open and judge
  the preview, and the packet prints the environment name to help.
- With a merge queue, `gh pr merge` succeeds on enqueue. The script says so in its final
  message; confirm the landing on GitHub.
- If `gh pr merge` is interrupted after GitHub committed the squash, the script cannot know;
  it prints a message asking the owner to check the PR before retrying.
- Tabs in paths are preserved and may misalign packet columns.
- Answers typed ahead of a prompt are accepted. Draining the terminal before each prompt
  would also break scripted terminals, so the owner is expected to read before typing.
- The preview is the first successful status of a deployment on the head commit, even if a
  later status marked that deployment inactive.
- PR body parsing is Markdown-light: HTML comments are stripped everywhere, including inside
  code spans, and a `#` line inside a fenced block ends the section being read.
- `install.sh` merges the Claude hook into an existing `.claude/settings.json` by parsing and
  re-serialising it: formatting, duplicate keys and numbers beyond double precision are not
  preserved. It keeps the file's mode.
