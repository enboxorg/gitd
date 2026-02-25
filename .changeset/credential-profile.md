---
"@enbox/gitd": patch
---

fix: credential helper uses identity profiles and signs with correct DID

The git credential helper (`git-remote-did-credential`) now resolves
the active identity profile before connecting to the agent, matching
the same resolution chain used by all `gitd` CLI commands (env var,
git config, global default, single fallback).

Also fixes a signing bug: the helper previously signed push tokens
with the internal agent DID but claimed the identity DID in the token
payload, which would cause signature verification to fail when the
server resolves the claimed DID's public key. Now signs with the
identity's own BearerDid signer.
