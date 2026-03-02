---
'@enbox/gitd': minor
---

Add `GET /repos/:did/:repo/pulls/:number/files` endpoint to GitHub shim

Returns the list of changed files for a pull request. Since DWN revision
records store only aggregate diff stats (additions, deletions, files
changed), the response includes a summary entry with the totals. This
unblocks tools like `gh pr diff --name-only` that require this endpoint.
