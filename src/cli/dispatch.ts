import type { AgentContext } from './agent.js';

import { ciCommand } from './commands/ci.js';
import { daemonCommand } from './commands/daemon.js';
import { githubApiCommand } from './commands/github-api.js';
import { indexerCommand } from '../indexer/main.js';
import { initCommand } from './commands/init.js';
import { issueCommand } from './commands/issue.js';
import { logCommand } from './commands/log.js';
import { migrateCommand } from './commands/migrate.js';
import { modCommand } from './commands/mod.js';
import { notificationCommand } from './commands/notification.js';
import { orgCommand } from './commands/org.js';
import { prCommand } from './commands/pr.js';
import { registryCommand } from './commands/registry.js';
import { releaseCommand } from './commands/release.js';
import { repoCommand } from './commands/repo.js';
import { serveCommand } from './commands/serve.js';
import { shimCommand } from './commands/shim.js';
import { socialCommand } from './commands/social.js';
import { webCommand } from './commands/web.js';
import { wikiCommand } from './commands/wiki.js';

export async function dispatchAgentCommand(
  ctx: AgentContext,
  command: string,
  rest: string[],
): Promise<void> {
  switch (command) {
    case 'init':
      await initCommand(ctx, rest);
      break;

    case 'issue':
      await issueCommand(ctx, rest);
      break;

    case 'pr':
    case 'patch':
      await prCommand(ctx, rest);
      break;

    case 'repo':
      await repoCommand(ctx, rest);
      break;

    case 'mod':
      await modCommand(ctx, rest);
      break;

    case 'serve':
      await serveCommand(ctx, rest);
      break;

    case 'release':
      await releaseCommand(ctx, rest);
      break;

    case 'registry':
      await registryCommand(ctx, rest);
      break;

    case 'ci':
      await ciCommand(ctx, rest);
      break;

    case 'wiki':
      await wikiCommand(ctx, rest);
      break;

    case 'org':
      await orgCommand(ctx, rest);
      break;

    case 'social':
      await socialCommand(ctx, rest);
      break;

    case 'notification':
    case 'notifications':
      await notificationCommand(ctx, rest);
      break;

    case 'migrate':
      await migrateCommand(ctx, rest);
      break;

    case 'web':
      await webCommand(ctx, rest);
      break;

    case 'indexer':
      await indexerCommand(ctx, rest);
      break;

    case 'daemon':
      await daemonCommand(ctx, rest);
      break;

    case 'github-api':
      await githubApiCommand(ctx, rest);
      break;

    case 'shim':
      await shimCommand(ctx, rest);
      break;

    case 'log':
      await logCommand(ctx, rest);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run `gitd help` for usage.');
      process.exit(1);
  }
}
