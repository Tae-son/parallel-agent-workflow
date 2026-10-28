## Summary

- What changed?
- Why does it matter to a user of this project?

## Scope

Approved brief: <!-- link or quote of the owner-approved brief; required for UI changes -->

Allowed paths:
<!-- one glob per line, copied from the brief, e.g. src/components/ -->

## Gate files

- Changed gate files and why: <!-- none, or list them; see CONTRIBUTING.md "Parallel agents" -->

## Evidence

- [ ] `npm run verify` passes locally
- [ ] GitHub CI passes
- [ ] I reviewed the complete diff
- [ ] I checked the affected screens or outputs, not just the build
- [ ] I included screenshots for visible changes, or explained why none are needed

## Independent QA

<!-- The separate QA session replaces this BLOCKED report after testing the exact head.
     See CONTRIBUTING.md "Independent QA". Keep exactly one active block, with these keys.
     Use real builder/reviewer session IDs. Record every criterion and observed evidence.
     New commits require QA retesting; do not merely update the SHA. -->
```independent-qa
{
  "version": 1,
  "head": "REPLACE_WITH_FULL_REVIEWED_SHA",
  "builder": "REPLACE_WITH_BUILDER_SESSION",
  "reviewer": "REPLACE_WITH_QA_SESSION",
  "verdict": "BLOCKED",
  "checks": [
    {
      "criterion": "REPLACE_WITH_ACCEPTANCE_CRITERION",
      "result": "BLOCKED",
      "evidence": "Independent QA has not run."
    }
  ],
  "blockers": ["Awaiting independent QA."],
  "limitations": "No independent testing performed yet."
}
```

## Risk and rollback

- Risk level: low / medium / high
- Known limitations:
- Rollback: revert this pull request

## Boundaries

- [ ] No credentials, private notes or unapproved personal data were added
- [ ] No unrelated files were changed
- [ ] No live deployment, DNS, account or payment action is included
- [ ] Claims, figures and external destinations are source-backed or clearly marked for review
