---
'@enbox/gitd': patch
---

Add `GITD_ALLOW_PRIVATE=1` env var to bypass SSRF protection for local development with `did:web:localhost` and other local DID methods. Prints a warning to stderr when active. Also exports `assertNotPrivateUrl` and adds comprehensive SSRF tests replacing the previous stub.
