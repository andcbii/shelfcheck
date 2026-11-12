## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `andcbii/shelfcheck`.
Before reading or changing issues, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels.
Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`.
Before exploring the codebase, read `docs/agents/domain.md`.

## Commit identity

When an AI agent writes the code, the agent is the commit author and
committer, not the repository owner. Set both per commit instead of
changing git config, for example:

```bash
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit ...
```

Each agent uses its own name and email (Claude: `Claude
<noreply@anthropic.com>`; Codex: `Codex <codex@openai.com>`).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
