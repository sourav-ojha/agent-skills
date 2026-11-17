# GitHub Access Recipes

Prefer `gh` CLI. If a GitHub MCP server is connected, its tools work equivalently — check with ToolSearch (`+github pull request`) before assuming `gh` is the only option. If neither is available, fall back to local git (see [Offline fallback](#offline-fallback)).

Verify access once at the start: `gh auth status`.

---

## Resolve the target PR

```bash
# Explicit number
PR=194

# PR for the current branch
PR=$(gh pr view --json number --jq .number)

# From a URL — gh accepts the URL directly anywhere a number is expected
gh pr view https://github.com/owner/repo/pull/194

# Different repo
gh pr view 194 --repo owner/repo
```

## Gather context

```bash
# Metadata in one call
gh pr view $PR --json number,title,body,author,url,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,labels,mergeable

# Full diff
gh pr diff $PR

# Diff stat only — use first to decide where to spend attention
gh pr diff $PR --name-only
gh pr view $PR --json files --jq '.files[] | "\(.additions)+/\(.deletions)- \(.path)"'

# Commit messages (checks commit-format conventions)
gh pr view $PR --json commits --jq '.commits[] | "\(.oid[0:7]) \(.messageHeadline)"'

# CI status — never duplicate what CI already caught
gh pr checks $PR
gh run view <run-id> --log-failed          # only for a failing run

# Existing review feedback — never repeat it
gh pr view $PR --json reviews --jq '.reviews[] | "\(.author.login) [\(.state)]: \(.body)"'
gh api repos/{owner}/{repo}/pulls/$PR/comments --jq '.[] | "\(.path):\(.line) \(.user.login): \(.body)"'
```

## Read full files, not just the diff

Diff context hides bugs. For any non-trivial hunk, read the whole file at the PR's head:

```bash
# Check out the PR locally (best option — enables reading, grepping, running tests)
gh pr checkout $PR

# Or read a single file at head without checking out
gh api repos/{owner}/{repo}/contents/path/to/file.ts?ref=$(gh pr view $PR --json headRefOid --jq .headRefOid) \
  --jq '.content' | base64 -d
```

After `gh pr checkout`, use the normal Read/Grep tools and, if the project supports it, run its linter/typecheck/tests.

## Posting the review — only when explicitly asked

Default is a written report in chat. Posting is outward-facing; get a clear yes first.

```bash
# Summary-level review
gh pr review $PR --comment --body-file review.md
gh pr review $PR --request-changes --body-file review.md
gh pr review $PR --approve --body "..."

# Standalone comment (no review state)
gh pr comment $PR --body-file review.md
```

### Inline, line-anchored comments

`gh pr review` has no inline flag. Use the API to submit one review carrying many inline comments:

```bash
gh api repos/{owner}/{repo}/pulls/$PR/reviews \
  -X POST \
  -f event=COMMENT \
  -f body="Overall summary here." \
  -f 'comments[][path]=src/auth.ts' \
  -F 'comments[][line]=42' \
  -f 'comments[][side]=RIGHT' \
  -f 'comments[][body]=Blocking: this path misses the tenant scope check.'
```

Repeat the `comments[][...]` triplet per comment. `line` must be a line present in the diff on the given `side` (`RIGHT` = head, `LEFT` = base). For a multi-line range add `start_line` and `start_side`.

For many comments, build a JSON payload instead:

```bash
gh api repos/{owner}/{repo}/pulls/$PR/reviews -X POST --input review.json
```

```json
{
  "event": "COMMENT",
  "body": "Summary…",
  "comments": [
    { "path": "src/auth.ts", "line": 42, "side": "RIGHT", "body": "…" },
    { "path": "src/db.ts", "start_line": 10, "line": 14, "side": "RIGHT", "body": "…" }
  ]
}
```

`event` values: `COMMENT`, `REQUEST_CHANGES`, `APPROVE`, or omit to save as a pending draft.

Note: GitHub blocks approving your own PR. If the PR author is the authenticated user, report in chat and say so rather than failing a post.

## Offline fallback

No `gh`, no MCP, or no PR yet — review the branch diff:

```bash
BASE=$(git symbolic-ref refs/remotes/origin/HEAD --short | sed 's|origin/||')
git fetch origin $BASE
git diff origin/$BASE...HEAD                 # three-dot: changes on this branch only
git diff --stat origin/$BASE...HEAD
git log --oneline origin/$BASE..HEAD
```

State clearly in the report that this was a branch-diff review, not a PR review, and that CI status was unavailable.

## Rate limits

```bash
gh api rate_limit --jq '.rate | "\(.remaining)/\(.limit), resets \(.reset|todate)"'
```

If limited, report the concrete reset timestamp rather than retrying blindly.
