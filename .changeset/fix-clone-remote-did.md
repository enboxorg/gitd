---
'@enbox/gitd': patch
---

fix: skip local daemon when cloning repos owned by a different DID

The local daemon resolver now checks `ownerDid` in the lockfile and
only routes to `localhost` when the requested DID matches the daemon
owner. Previously, cloning any DID would hit the local daemon — which
does not have the remote user's repos — and fail with 404.
