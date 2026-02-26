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
 * @param dataPath - Agent data directory (e.g. `~/.enbox/profiles/<name>/DATA/AGENT`).
 * @param didResolver - DID resolver instance, forwarded to `Dwn.create()`.
 * @returns A ready-to-use `AgentDwnApi`.
 */
export async function createSqliteDwnApi(
  dataPath: string,
  didResolver?: Parameters<typeof AgentDwnApi.createDwn>[0]['didResolver'],
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

  const dwn = await Dwn.create({
    dataStore,
    messageStore,
    stateIndex,
    resumableTaskStore,
    eventLog,
    didResolver,
  });

  return new AgentDwnApi({ dwn });
}
