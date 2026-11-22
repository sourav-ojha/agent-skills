# Feature Intake on Claude Code

## Install the skill
```bash
npx skills add <repo-or-path> --skill feature-intake          # project
npx skills add <repo-or-path> --skill feature-intake -g       # global
```
Or copy `skills/feature-intake` to `.claude/skills/feature-intake` (project) or `~/.claude/skills/feature-intake` (global).
No native agents and no extra configuration: the skill runs in the main session.

## Use
`/feature-intake add CSV export to the reports page`, `/feature-intake --source docs/prd/export.md`, or in plain words:
"turn this bug into a feature spec", "write a spec for the implementer". The agent reads the code, fills the spec, runs
`fi validate` and `fi check`, shows you the result and waits. Say yes in the chat to approve; it records your words with
`fi approve`. Then hand the spec to `/implementer .product/features/FEATURE-NNN.md` or the delivery-orchestrator queue.

## Tips
- Commit `.product/features/` with the code it describes; `.skill-runs/` ignores itself.
- Keep spec files on LF line endings (`* text=auto eol=lf` in `.gitattributes` on Windows checkouts); the lifecycle verbs refuse CRLF.
- Approval is tamper-evident, not tamper-proof: the real gate is you reading the spec before you say yes.
- Other hosts: the skill is agent-neutral (`SKILL.md` plus a Node helper); no other host adapter is written yet.

## Where the helper lives
Installed skills live in `<project>/.claude/skills/feature-intake` (project install) or `~/.claude/skills/feature-intake` (global).
`fi` is `node <that folder>/core/scripts/fi.mjs`; it is not copied into your project. Update with `npx skills update`.
