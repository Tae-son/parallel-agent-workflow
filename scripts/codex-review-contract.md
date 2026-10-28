## Standing safeguards for this project (apply to every change)

<!-- Edit this list for your project. codex-review.sh appends it to every payload after the
     PR's Scope and Allowed paths, so the reviewer judges the diff against your invariants. -->

- No secrets, tokens or credentials in the repository, in tests or in fixtures.
- No new runtime network calls, remote assets or third-party scripts unless the brief names them.
- No new persistent client-side storage (localStorage, sessionStorage, IndexedDB, cookies) unless the brief names it.
- Invalid input produces a specific error; it never silently proceeds with bad values.
- Missing data is shown as missing, never fabricated or silently defaulted.
- Behaviour covered by tests changes only together with its tests.
