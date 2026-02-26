---
'@enbox/gitd': patch
---

Replace LevelDB with SQLite for DWN core stores (MessageStore, DataStore, StateIndex, ResumableTaskStore) using `@enbox/dwn-sql-store` and Bun's native `bun:sqlite`. The remaining LevelDB stores (SyncEngine, vault, DID resolver cache) await upstream SQL alternatives (enboxorg/enbox#569, enboxorg/enbox#570).
