#!/usr/bin/env bun
/**
 * Indexer entry point — starts the crawler loop and REST API server.
 *
 * Usage:
 *   dwn-git indexer [--port <api-port>] [--interval <seconds>] [--seed <did>]
 *
 * Environment:
 *   DWN_GIT_PASSWORD       Vault password (prompted if not set)
 *   DWN_GIT_INDEXER_PORT   API port (default: 8090)
 *   DWN_GIT_INDEXER_INTERVAL  Crawl interval in seconds (default: 60)
 *
 * The indexer requires a local Web5 agent for signing DWN query
 * messages.  On first run it initializes the agent vault.  Subsequent
 * runs unlock the existing vault.
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';

import { flagValue } from '../cli/flags.js';
import { IndexerCrawler } from './crawler.js';
import { IndexerStore } from './store.js';
import { startApiServer } from './api.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function indexerCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const port = parseInt(
    flagValue(args, '--port') ?? process.env.DWN_GIT_INDEXER_PORT ?? '8090', 10,
  );
  const intervalSec = parseInt(
    flagValue(args, '--interval') ?? process.env.DWN_GIT_INDEXER_INTERVAL ?? '60', 10,
  );
  const seedDid = flagValue(args, '--seed');

  const store = new IndexerStore();
  const crawler = new IndexerCrawler(ctx, store);

  // Seed the local agent's DID.
  store.addDid(ctx.did);

  // If a seed DID is provided, discover DIDs from its social graph.
  if (seedDid) {
    console.log(`[indexer] Discovering DIDs from seed: ${seedDid}`);
    const discovered = await crawler.discover(seedDid, 2);
    console.log(`[indexer] Discovered ${discovered.length} DIDs`);
  }

  // Initial crawl before starting the API.
  console.log('[indexer] Running initial crawl...');
  const result = await crawler.crawl();
  console.log(
    `[indexer] Initial crawl complete: ${result.crawledDids} DIDs, `
    + `${result.newRepos} repos, ${result.newStars} stars, ${result.newFollows} follows`,
  );
  if (result.errors.length > 0) {
    console.log(`[indexer] ${result.errors.length} errors during initial crawl`);
  }

  // Start the periodic crawl loop.
  const stopCrawler = crawler.startLoop(intervalSec * 1000);

  // Start the API server.
  startApiServer({ store, port });

  console.log(`[indexer] Crawl interval: ${intervalSec}s`);
  console.log('[indexer] Press Ctrl+C to stop.\n');

  // Handle shutdown.
  process.on('SIGINT', () => {
    console.log('\n[indexer] Shutting down...');
    stopCrawler();
    process.exit(0);
  });

  // Keep the process alive.
  await new Promise(() => {});
}
