---
'@enbox/gitd': patch
---

Fix GitHub shim author fields to use record author instead of repo owner

All `user` fields in the GitHub shim (issues, comments, PRs, reviews) now
reflect the actual DWN record author (`record.author`) instead of always
showing the repository owner. The `merged_by` field on pull requests now
reads the `mergedBy` DID from the merge result data payload instead of
hardcoding the owner. The `author_association` field is dynamically set
to `'OWNER'` or `'CONTRIBUTOR'` based on whether the author matches the
repository owner.
