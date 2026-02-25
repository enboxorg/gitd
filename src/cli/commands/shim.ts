/**
 * `gitd shim` — start a package manager / registry compatibility shim.
 *
 * Usage:
 *   gitd shim npm [--port 4873]   Start npm registry shim
 *   gitd shim go  [--port 4874]   Start Go module proxy shim
 *   gitd shim oci [--port 5555]   Start OCI/Docker registry shim
 *
 * Each shim starts a local HTTP proxy that speaks the native protocol of
 * the ecosystem tool, resolving DID-scoped packages from DWN records.
 *
 * @module
 */

import type { AgentContext } from '../agent.js';

import { startGoShim } from '../../shims/go/server.js';
import { startNpmShim } from '../../shims/npm/server.js';
import { startOciShim } from '../../shims/oci/server.js';
import { flagValue, parsePort } from '../flags.js';

// ---------------------------------------------------------------------------
// Default ports
// ---------------------------------------------------------------------------

const DEFAULT_NPM_PORT = '4873';
const DEFAULT_GO_PORT = '4874';
const DEFAULT_OCI_PORT = '5555';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function shimCommand(ctx: AgentContext, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'npm': {
      const port = parsePort(
        flagValue(rest, '--port') ?? process.env.GITD_NPM_SHIM_PORT ?? DEFAULT_NPM_PORT,
      );
      console.log('Starting npm registry shim...');
      startNpmShim({ ctx, port });
      await new Promise(() => {});
      break;
    }

    case 'go': {
      const port = parsePort(
        flagValue(rest, '--port') ?? process.env.GITD_GO_SHIM_PORT ?? DEFAULT_GO_PORT,
      );
      console.log('Starting Go module proxy shim...');
      startGoShim({ ctx, port });
      await new Promise(() => {});
      break;
    }

    case 'oci':
    case 'docker': {
      const port = parsePort(
        flagValue(rest, '--port') ?? process.env.GITD_OCI_SHIM_PORT ?? DEFAULT_OCI_PORT,
      );
      console.log('Starting OCI/Docker registry shim...');
      startOciShim({ ctx, port });
      await new Promise(() => {});
      break;
    }

    default:
      console.error('Usage: gitd shim <npm|go|oci> [--port <port>]');
      console.error('');
      console.error('Shims:');
      console.error(`  npm     npm registry proxy (default port: ${DEFAULT_NPM_PORT})`);
      console.error(`  go      Go module proxy (default port: ${DEFAULT_GO_PORT})`);
      console.error(`  oci     OCI/Docker registry proxy (default port: ${DEFAULT_OCI_PORT})`);
      process.exit(1);
  }
}
