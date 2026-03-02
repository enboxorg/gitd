---
'@enbox/gitd': patch
---

Harden SSRF protection against DNS rebinding attacks

`assertNotPrivateUrl` now resolves hostnames via DNS (A + AAAA) and
checks the resulting IP addresses against private ranges. Previously,
only the hostname string was checked, allowing DNS names that resolve to
`127.0.0.1` to bypass the filter.

Also blocks IPv6-mapped IPv4 addresses (`::ffff:127.0.0.1`) and the
unspecified address (`::`).
