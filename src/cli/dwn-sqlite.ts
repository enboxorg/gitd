/**
 * SQLite-backed DWN store factory.
 *
 * Replaces the default LevelDB stores (`MessageStoreLevel`, `DataStoreLevel`,
 * `StateIndexLevel`, `ResumableTaskStoreLevel`) with their SQL equivalents
 * from `@enbox/dwn-sql-store`, backed by Bun's native `bun:sqlite`.
 *
 * This eliminates the `classic-level` / `node-gyp` native dependency for
 * the four core DWN stores.  The remaining Level-based components
 * (`SyncEngineLevel`, `LevelStore` for the vault, `AgentDidResolverCache`)
 * stay on LevelDB until SQL alternatives are available upstream.
 *
 * @module
 */

import type { Dialect } from '@enbox/dwn-sql-store';

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { AgentDwnApi } from '@enbox/agent';
import { Kysely } from 'kysely';

import {
  createBunSqliteDatabase,
  DataStoreSql,
  MessageStoreSql,
  ResumableTaskStoreSql,
  runDwnStoreMigrations,
  SqliteDialect,
  StateIndexSql,
} from '@enbox/dwn-sql-store';
import {
  DidDht,
  DidJwk,
  DidKey,
  DidResolverCacheLevel,
  DidWeb,
  UniversalResolver,
} from '@enbox/dids';
import { Dwn, EventEmitterEventLog } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an `AgentDwnApi` backed by a single SQLite file.
 *
 * The database is placed at `<dataPath>/dwn.sqlite`.  All four DWN core
 * stores share the same connection through a common `SqliteDialect`.
 *
 * A profile-scoped DID resolver cache is created at
 * `<dataPath>/DWN_RESOLVERCACHE` to avoid leaking a `RESOLVERCACHE/`
 * directory into the current working directory.
 *
 * @param dataPath - Agent data directory (e.g. `~/.enbox/profiles/<name>/DATA/AGENT`).
 * @returns A ready-to-use `AgentDwnApi`.
 */
export async function createSqliteDwnApi(
  dataPath: string,
): Promise<AgentDwnApi> {
  mkdirSync(dataPath, { recursive: true });

  const dbPath = join(dataPath, 'dwn.sqlite');
  const sqliteDb = createBunSqliteDatabase(dbPath);
  const dialect: Dialect = new SqliteDialect({ database: async () => sqliteDb });

  // Run schema migrations before opening any stores.
  const migrationDb = new Kysely<Record<string, unknown>>({ dialect });
  await runDwnStoreMigrations(migrationDb, dialect);

  const messageStore = new MessageStoreSql(dialect);
  const dataStore = new DataStoreSql(dialect);
  const stateIndex = new StateIndexSql(dialect);
  const resumableTaskStore = new ResumableTaskStoreSql(dialect);
  const eventLog = new EventEmitterEventLog();

  // Create a profile-scoped DID resolver with its cache inside the
  // agent data directory.  Without this, Dwn.create() falls back to a
  // CWD-relative `RESOLVERCACHE/` directory.
  const didResolver = new UniversalResolver({
    didResolvers : [DidDht, DidJwk, DidKey, DidWeb],
    cache        : new DidResolverCacheLevel({ location: join(dataPath, 'DWN_RESOLVERCACHE') }),
  });

  const dwn = await Dwn.create({
    dataStore,
    messageStore,
    stateIndex,
    resumableTaskStore,
    eventLog,
    didResolver,
  });

  return new AgentDwnApi({ dwn } as any);
}
