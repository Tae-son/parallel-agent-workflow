# Independent QA report rules, shared by scripts/land.sh (the owner's merge gate) and
# scripts/independent-qa-status.sh (the visible commit status). Both read this file from
# main's exact commit, never from a pull request. See CONTRIBUTING.md "Independent QA".
# Structural checks only: a report that passes is a declaration, not authentication.

# The report object from a PR JSON's raw body: exactly one ```independent-qa fence (CRLF
# allowed), closed, holding a JSON object. Produces no output for anything else.
def qa_report:
  .body | select(type == "string")
  | select(([scan("(?m)^```independent-qa\\r?$")] | length) == 1)
  | capture("(?m)^```independent-qa\\r?\n(?<report>[\\s\\S]*?)^```\\r?$")
  | .report | fromjson | select(type == "object");

def qa_text: type == "string" and test("[^\\s]");
def qa_session: type == "string" and test("\\A[A-Za-z0-9][A-Za-z0-9._:/-]*\\z");

# True only for a version 1 PASS on $head with distinct sessions, PASS evidence for every
# check, no blockers, limitations and no extra keys. Input: the object from qa_report.
def qa_pass($head):
  (keys == ["blockers", "builder", "checks", "head", "limitations", "reviewer", "verdict", "version"])
  and .version == 1 and .head == $head and .verdict == "PASS"
  and (.builder | qa_session) and (.reviewer | qa_session) and .builder != .reviewer
  and (.limitations | qa_text)
  and (.blockers | type == "array" and length == 0)
  and (.checks | type == "array" and length > 0 and all(.[];
    type == "object" and keys == ["criterion", "evidence", "result"]
    and (.criterion | qa_text) and (.evidence | qa_text) and .result == "PASS"));
