/**
 * @enbox/gitd — Decentralized forge protocols for DWN.
 *
 * Protocol definitions for a decentralized GitHub alternative.
 * See PLAN.md for full architecture documentation.
 *
 * Each protocol exports:
 * - Data shape types for each record type (e.g. `IssueData`, `RepoData`)
 * - A `SchemaMap` type mapping type names to data shapes
 * - A raw `ProtocolDefinition` (e.g. `ForgeRepoDefinition`)
 * - A typed protocol created via `defineProtocol()` (e.g. `ForgeRepoProtocol`)
 *
 * @packageDocumentation
 */

export * from './repo.js';
export * from './refs.js';
export * from './issues.js';
export * from './patches.js';
export * from './ci.js';
export * from './releases.js';
export * from './registry.js';
export * from './social.js';
export * from './notifications.js';
export * from './wiki.js';
export * from './org.js';
