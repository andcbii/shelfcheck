# Shelfcheck 2.5.5

Shelfcheck 2.5.5 improves the Manual Matches report and editing workflow.

## Manual Match improvements

- Compact cards group episodes by show and keep the report easier to scan.
- Add and edit Manual Matches in a focused popup with keyboard navigation.
- Saving closes the editor and shows a brief Saved confirmation. Closing with
  unsaved changes asks whether to discard them, and saving pauses during a
  Plex scan.
- Single and bulk deletes require confirmation. Bulk actions appear only when
  matches are selected.
- Manual Match wording is consistent throughout the report and editor.

## Support and packaging

The README links release history, support and the security policy, with guidance
on supplying version information and credential-safe diagnostic logs. Local agent
instructions, private runtime context and generated artifacts are excluded from
published sources and Docker build contexts.

## Upgrading

Use `andcbii/shelfcheck:2.5.5` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.
No configuration or database reset is required.
