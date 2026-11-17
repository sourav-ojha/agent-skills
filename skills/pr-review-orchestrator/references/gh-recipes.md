# GitHub Access Recipes

Prefer the `gh` CLI. If a GitHub MCP server is connected, its tools work equivalently — check with `ToolSearch` (`+github pull request`) before assuming `gh` is the only route. If neither is available, use the offline fallback.

Verify once at the start: `gh auth status`.

**Distinguish the three failure modes** — they need different responses:

| Symptom | Meaning | Do |
|---|---|---|
| `gh: command not found` | Not installed | Try a GitHub MCP tool; else offline fallback |
| `gh auth status` reports not logged in | Installed, unauthenticated | Stop. Tell the user to run `gh auth login`. Do not silently review a local diff and call it a PR review |
| Authenticated, but `gh pr view` errors with 404/`Could not resolve` | Wrong account, or no access to this repo | Report the active account (`gh api user --jq .login`) and that it cannot resolve the repo. Do not conclude the PR does not exist |

## Resolve the target

```bash
PR=194                                            # explicit number
PR=$(gh pr view --json number --jq .number)       # PR for the current branch
gh pr view https://github.com/owner/repo/pull/194 # a URL works anywhere a number does
gh pr view 194 --repo owner/repo                  # different repo
```

## Gather context

```bash
# Metadata + risk signals in ONE call — this is the canonical field set.
# mergeable and headRefOid are required: conflict detection and revision anchoring.
gh pr view $PR --json number,title,body,author,url,baseRefName,headRefName,\
additions,deletions,changedFiles,labels,isDraft,mergeable,headRefOid

# Shape of the change — do this BEFORE the full diff, it drives tier selection
gh pr diff $PR --name-only

# Full diff
gh pr diff $PR

# Commit messages — often the truest statement of intent
gh pr view $PR --json commits --jq '.commits[].messageHeadline'

# CI state — use these results instead of re-running an expensive suite
gh pr checks $PR
gh pr view $PR --json statusCheckRollup

# Existing review feedback — never repeat what someone already said
gh pr view $PR --json reviews,comments

# Linked issue / acceptance criteria
gh issue view <n> --json title,body
```

## Read files at the PR's head

The diff hides the bug more often than it reveals it. Read whole files at the PR's revision.

First establish which revision you are on:

```bash
gh pr view $PR --json headRefOid --jq .headRefOid   # the PR's head
git rev-parse HEAD                                   # what is on disk
```

**They match** → read locally with the `Read` tool. Fast path, and the usual case.

**They differ** → read at the PR's revision without touching the working tree:

```bash
gh api repos/{owner}/{repo}/contents/<path>?ref=<headRefOid> --jq .content | base64 -d
```

Never `gh pr checkout`. It switches branches and writes to the working tree — outside what a read-only review may do, and destructive if the user has uncommitted work.

Prefer the API form. Do not check out a PR over a dirty working tree.

## Offline fallback (no `gh`, no MCP)

```bash
BASE=$(git symbolic-ref refs/remotes/origin/HEAD --short | sed 's|origin/||')
MB=$(git merge-base HEAD origin/$BASE)
git diff --name-only $MB...HEAD
git diff $MB...HEAD
git log --oneline $MB..HEAD
```

State clearly in the report that you reviewed a branch diff, not a PR, and that PR description, CI status, and existing review comments were unavailable.

## Regression check — by reading only

To judge whether a bug-fix test would have failed before the fix, **read**: does the assertion depend on a line the diff changed? Trace it and say so.

Do **not** create a worktree, clone, or scratch checkout, and do not revert code to find out. `git worktree add` writes to `.git/worktrees/`, takes `index.lock`, and leaks a stale entry if the review is interrupted — and the stash stack is shared with every other worktree and session. None of that is acceptable inside a read-only review.

If reading is inconclusive, report the regression value as unverified.

## Posting (only on explicit request)

Do not run these unless the user asks in the current conversation.

```bash
gh pr review $PR --comment --body-file review.md
gh pr review $PR --request-changes --body "..."
gh pr review $PR --approve --body "..."

# Inline comment on a specific line
gh api repos/{owner}/{repo}/pulls/$PR/comments \
  -f body="..." -f commit_id="$(gh pr view $PR --json headRefOid --jq .headRefOid)" \
  -f path="src/x.ts" -F line=82 -f side=RIGHT
```

Never `gh pr merge`. Merging is not part of a review.
