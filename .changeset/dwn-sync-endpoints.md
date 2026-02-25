---
"@enbox/gitd": minor
---

Enable DWN sync and populate DWN endpoints in repo records. `connectAgent` now accepts a `sync` option (defaults to `'off'` for one-shot commands, `'30s'` for long-running commands like `serve`). Controlled via `GITD_SYNC` env var or `--sync`/`--no-sync` flags. `gitd init` auto-populates `dwnEndpoints` from the DID document's `DecentralizedWebNode` service, overridable with `--dwn-endpoint` flag or `GITD_DWN_ENDPOINT` env. `gitd serve` ensures all repo records have current DWN and git endpoints at startup, and periodically republishes `did:dht` documents to keep them alive on the DHT network.
