# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `andcbii/shelfcheck`.
Use the `gh` CLI from this checkout.

## Conventions

- Verify the target before the first issue creation in a session:
  `gh repo view --json nameWithOwner`.
- Create: `gh issue create --title "..." --body-file <path>`.
  For multiline bodies, write the exact text to a temporary file.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
  Add label and state filters as needed.
- Comment: `gh issue comment <number> --body-file <path>`.
- Add/remove labels: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`.
- Close: post the explanation as a comment, then run
  `gh issue close <number>`. Comment separately on already-closed issues.

File issues into the user's repository. If the resolved target differs
from `andcbii/shelfcheck`, confirm the intended destination before creating.

## Parent issues and blockers

Use GitHub's native sub-issues and issue dependencies when available.

- Parent: use `gh issue create --parent <parent>` or
  `gh issue edit <parent> --add-sub-issue <child>` when supported.
  Older CLI fallback:
  `gh api --method POST repos/andcbii/shelfcheck/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.
- Blocker: use `gh issue edit <child> --add-blocked-by <blocker>`
  when supported. Older CLI fallback:
  `gh api --method POST repos/andcbii/shelfcheck/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
- Obtain database IDs with
  `gh api repos/andcbii/shelfcheck/issues/<number> --jq .id`.
  Database IDs differ from issue numbers and node IDs.
- If native relationships are unavailable, put `Part of #<parent>` and
  `Blocked by: #<number>` at the top of the child body, and maintain
  a child task list in the parent.
- A ticket is unblocked when every blocker is closed. Native open-blocker
  count:
  `gh api repos/andcbii/shelfcheck/issues/<number> --jq .issue_dependencies_summary.blocked_by`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill terminology

"Publish to the issue tracker" means create a GitHub issue.
"Fetch the relevant ticket" means read the corresponding GitHub issue.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child: a sub-issue of the map, labelled `wayfinder:<type>`, where type
  is research, prototype, grilling, or task.
- Frontier: open children without an assignee or open blocker;
  choose the first in map order.
- Claim: `gh issue edit <number> --add-assignee "@me"`.
- Resolve: comment with the answer, close the child, then append a
  concise finding and link to the map's Decisions-so-far.
