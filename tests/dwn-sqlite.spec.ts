import { afterEach, describe, expect, it } from 'bun:test';

import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

import { createBunSqliteDatabase, SqliteDialect } from '@enbox/dwn-sql-store';
import { Kysely, sql } from 'kysely';

import { repairGitdDwnSqliteStore, runGitdDwnStoreMigrations } from '../src/cli/dwn-sqlite.js';

const TEST_DIR = '__TESTDATA__/dwn-sqlite';

describe('gitd DWN SQLite migrations', () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should tolerate a pre-existing squash column with migration 003 pending', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const sqliteDb = createBunSqliteDatabase(join(TEST_DIR, 'dwn.sqlite'));
    const dialect = new SqliteDialect({ database: async (): Promise<typeof sqliteDb> => sqliteDb });
    const db = new Kysely<Record<string, unknown>>({ dialect });

    try {
      await sql`
        CREATE TABLE kysely_migration (
          name varchar(255) PRIMARY KEY,
          timestamp varchar(255) NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE TABLE kysely_migration_lock (
          id varchar(255) PRIMARY KEY,
          is_locked integer DEFAULT 0 NOT NULL
        )
      `.execute(db);
      await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('001-initial-schema', '2026-06-23T00:00:00.000Z')`.execute(db);
      await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('002-content-addressed-datastore', '2026-06-23T00:00:01.000Z')`.execute(db);
      await sql`
        CREATE TABLE messageStoreMessages (
          tenant varchar(255) NOT NULL,
          messageCid varchar(60) NOT NULL,
          protocol varchar(200),
          squash boolean
        )
      `.execute(db);

      const applied = await runGitdDwnStoreMigrations(db, dialect);
      expect(applied).toContain('003-add-squash-column');
      expect(applied).toContain('004-replication-log');

      const columns = await sql<{ name: string }>`
        SELECT name FROM pragma_table_info('messageStoreMessages') WHERE name = 'squash'
      `.execute(db);
      expect(columns.rows).toHaveLength(1);
    } finally {
      await db.destroy();
      sqliteDb.close();
    }
  });

  it('should repair a profile store with a pre-existing squash column and missing migration marker', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const sqliteDb = createBunSqliteDatabase(join(TEST_DIR, 'dwn.sqlite'));
    const dialect = new SqliteDialect({ database: async (): Promise<typeof sqliteDb> => sqliteDb });
    const db = new Kysely<Record<string, unknown>>({ dialect });

    try {
      await sql`
        CREATE TABLE kysely_migration (
          name varchar(255) PRIMARY KEY,
          timestamp varchar(255) NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE TABLE kysely_migration_lock (
          id varchar(255) PRIMARY KEY,
          is_locked integer DEFAULT 0 NOT NULL
        )
      `.execute(db);
      await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('001-initial-schema', '2026-06-23T00:00:00.000Z')`.execute(db);
      await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('002-content-addressed-datastore', '2026-06-23T00:00:01.000Z')`.execute(db);
      await sql`
        CREATE TABLE messageStoreMessages (
          tenant varchar(255) NOT NULL,
          messageCid varchar(60) NOT NULL,
          protocol varchar(200),
          squash boolean
        )
      `.execute(db);
    } finally {
      await db.destroy();
      sqliteDb.close();
    }

    const result = await repairGitdDwnSqliteStore(TEST_DIR);
    expect(result.status).toBe('fixed');
    expect(result.appliedMigrations).toContain('003-add-squash-column');

    const repairedSqliteDb = createBunSqliteDatabase(join(TEST_DIR, 'dwn.sqlite'));
    const repairedDialect = new SqliteDialect({ database: async (): Promise<typeof repairedSqliteDb> => repairedSqliteDb });
    const repairedDb = new Kysely<Record<string, unknown>>({ dialect: repairedDialect });
    try {
      const migration = await sql<{ name: string }>`
        SELECT name FROM kysely_migration WHERE name = '003-add-squash-column'
      `.execute(repairedDb);
      expect(migration.rows).toHaveLength(1);
    } finally {
      await repairedDb.destroy();
      repairedSqliteDb.close();
    }
  });

  it('should not create a missing profile store during repair', async () => {
    const result = await repairGitdDwnSqliteStore(TEST_DIR);
    expect(result.status).toBe('missing');
  });
});
