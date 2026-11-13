# Issue tracker: Jira

Issues and specs live in the **Shelfcheck** Jira project, key `SHELFCHECK`,
at `https://alderaan-mdm.atlassian.net`.
Project ID: `10037`. Atlassian cloud ID: `b042672b-60fc-4a47-a423-5d91875b2cd3`.
Use the connected Atlassian tools for issue operations.

Code, branches, pull requests, and inline PR review threads remain in
GitHub repository `andcbii/shelfcheck`.

## Conventions

- Before the first issue creation in a session, verify that the destination
  project is `SHELFCHECK` on the site above.
- Use full issue keys, such as `SHELFCHECK-123`, and link to
  `https://alderaan-mdm.atlassian.net/browse/SHELFCHECK-123`.
- Search before creating to check for an existing issue. Scope project searches
  with JQL `project = SHELFCHECK`; add `statusCategory != Done` for open work.
- Use Bug for defects, Story for user-facing functionality, Task for other work,
  and Epic for a specification spanning multiple implementation issues.
  Sub-task is available for work within a standard issue.
- Read the description, comments, status, parent, and dependency links before
  implementing or changing an issue.
- Store specifications and acceptance criteria in the Jira description. Keep
  multiline formatting when creating or editing descriptions and comments.
- Apply the triage labels from `docs/agents/triage-labels.md` through Jira's
  Labels field, preserving unrelated labels.
- Before changing status, inspect the issue's available workflow transitions.
  To close an issue, comment with the result and validation, then transition it
  to CLOSED under the completion rules below. Comment separately on already-completed work.
- Verify saved descriptions, labels, relationships, and status after mutations.

If the resolved destination differs from this project or site, confirm the
intended destination before creating issues.

## Workflow states

| State | Meaning and transition point |
| --- | --- |
| UNDEFINED | Captured work that still needs requirements or acceptance criteria. |
| DEFINED | Scope, acceptance criteria, and dependencies are clear enough to implement. |
| IN PROGRESS | Implementation or testing is underway. |
| RESOLVED | Implementation is ready for review. For code changes, the PR is open and ready for review; link it and record validation results. |
| CLOSED | Review is complete, required code is merged, checks pass, and acceptance criteria and any required deployment verification are satisfied. |
| REJECTED | Work is deliberately declined; record the reason. |

PR review belongs in RESOLVED. An open PR alone does not qualify for CLOSED.
For work without a PR, RESOLVED means the result is ready for review or acceptance.
If implementation reveals unclear requirements, use the available IN PROGRESS
to UNDEFINED transition and explain the outstanding questions. Inspect available
transitions before moving work back for review fixes; retain the open findings.
Close an Epic only after its required children and overall acceptance criteria
are complete.

## Parent issues and blockers

Use Jira's native Parent field for the supported hierarchy: Epic to standard
issues, and a standard issue to Sub-tasks. Inspect the project metadata before
setting a parent; use the relationship supported by the selected issue types.

Use native issue links for dependencies, with the correct **blocks / is blocked
by** direction. Inspect available link types before writing links. A child is
unblocked when all of its blockers are CLOSED. A REJECTED blocker requires an
explicit dependency decision; it does not establish that the prerequisite was delivered.

If a required relationship is unavailable, put `Part of SHELFCHECK-<number>`
and `Blocked by: SHELFCHECK-<number>` with links at the top of the child
description, and maintain a linked child checklist in the parent.

## Pull requests as a triage surface

**PRs as a request surface: no.** Track requested work in Jira and link the
relevant Jira issue from its GitHub pull request. Follow `AGENTS.md` for PR
review publication and conversation resolution.

## Tracker terminology and existing references

"Publish to the issue tracker" means create a Jira issue in `SHELFCHECK`.
"Fetch the relevant ticket" means read its Jira issue.

Existing GitHub issues remain in place until the user requests migration.
Explicit GitHub issue URLs and historical `#<number>` references still identify
GitHub issues; use `gh` to read them. Preserve those references in historical
docs. New work uses Jira keys. Any future migration must preserve the original
GitHub link and record the corresponding Jira key.

## Wayfinding operations

- Map: one Jira issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog. Use an Epic when its children are standard issues.
- Child: a native child of the map where the hierarchy supports it, labelled
  `wayfinder:<type>`; type is research, prototype, grilling, or task. Use a linked
  child checklist when the hierarchy cannot represent the relationship.
- Frontier: open children without an assignee or unresolved blocker;
  choose the first in map order.
- Claim: resolve the authenticated user's Jira account ID and assign the issue
  to that account.
- Resolve: comment with the answer, transition the child to RESOLVED for review,
  then append a concise finding and link to the map's Decisions-so-far.
  Transition to CLOSED only after the workflow completion rules are satisfied.
