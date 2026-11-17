# Vendoring and bootstrap (PR 3 of 3)

## Intent
One repo holds everything the user relies on: own skills, vendored third-party skills (pinned, license kept, syncable) and pin-only
references. A new machine is restored with one command. Real usage (skill-insights, Jan-Nov 2026) decided what is ported.

## Decisions (user)
Port own used skills (autonomous, pr-review, pr-review-orchestrator, phased-review, retro and the deep-pr-review/pr-review commands);
vendor a Superpowers subset (MIT, pinned v7.0.2); pin-only for graphify and security-audit (provenance unconfirmed); skip the 12
unused design/image skills; leave the separate `ai-skills` repo for later.

## Model
`skills.lock.json` lists every managed item: `kind` (skill|command), `origin` (authored | imported | vendored | external), `path`,
and for vendored `source {repo, ref, path}`, `license`, `upstreamHash` (upstream tree at ref, after the declared `transform`),
`hash` (local tree). `imported` = first-party legacy skill copied in as-is (relaxed validation). `external` = not copied; install hint only.
Third-party license text lives in `third_party/<slug>/LICENSE`.

## Commands (`node scripts/skills.mjs`)
- `status`: per item, local tree vs lock hash (local edits), missing paths, license files.
- `check`: newer upstream tags for vendored items (`git ls-remote`, no clone).
- `vendor <name> --repo URL --ref TAG --path P [--license MIT] [--strip-namespace PREFIX]`: import from upstream at a pinned ref.
- `update <name> [--ref TAG] [--apply] [--force]`: show what upstream changed; `--apply` writes it; refused if local edits exist unless `--force`.
- `bootstrap [--scope user|project] [--project-dir D] [--dry-run] [--force]`: copy managed items into the host (`~/.claude` or `<project>/.claude`).

## Safety
No network except git against the lock's repo; no code from upstream is executed; symlinks in upstream or destinations are refused;
lock paths must be relative without `..`; repo URLs limited to https, ssh and file; managed installs carry a marker, unmanaged
existing items are never overwritten without `--force` (moved aside, not deleted).

## Acceptance criteria
- AC1 Tree hash is deterministic, order-independent, content-sensitive and refuses symlinks.
- AC2 `vendor` imports a subset at a pinned ref, applies the namespace transform, records hashes, copies the license.
- AC3 `status` detects local edits and missing items.
- AC4 `update` is a dry run by default; `--apply` updates files and lock; local edits block it without `--force`.
- AC5 `bootstrap` installs skills and commands with a marker, refuses unmanaged and symlinked destinations, supports `--dry-run`, prints hints for external items.
- AC6 The repo lock is consistent: every `skills/*` has an entry, vendored hashes match, license files exist, validator relaxes imported/vendored items.
- AC7 Lock paths with `..` or absolute paths, and unsupported URL schemes, are rejected.

## Known limits
Vendored Superpowers skills lose the plugin's hooks and agents and are invoked by bare name (`brainstorming`, not `superpowers:brainstorming`);
the declared transform rewrites in-text `superpowers:` references. Not runtime-tested here. Only version pinning, no 3-way merge of local edits.
