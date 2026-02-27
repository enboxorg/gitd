---
'@enbox/gitd': patch
---

Fix `did:` prefix doubling when remote URL contains the full DID (`did::did:dht:.../repo`). The URL parser now accepts both short (`dht:id/repo`) and full (`did:dht:id/repo`) forms.
