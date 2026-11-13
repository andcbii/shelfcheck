# Jira pull request automation smoke test

Test Story: [SHELFCHECK-1](https://alderaan-mdm.atlassian.net/browse/SHELFCHECK-1).

Use this documentation-only change to verify the GitHub-to-Jira automation.
Keep `SHELFCHECK-1` at the start of the pull request title.

1. Open the pull request as a draft while the Story is IN PROGRESS.
   Expected: the Story remains IN PROGRESS.
2. Mark the pull request ready for review.
   Expected: the Story moves to RESOLVED.
3. After review and required checks, merge the pull request into `main`.
   Expected: the Story moves to CLOSED.

Inspect Jira's automation audit log after each event. Leave Jira status changes
to the automation during this test so manual changes do not mask failures.
Closing a pull request without merging must not move the Story to CLOSED.
