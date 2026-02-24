/**
 * `dwn-git clone <did>/<repo>` — clone a repository by DID.
 *
 * Convenience wrapper that:
 * 1. Validates the DID/repo argument
 * 2. Spawns `git clone did::<did>/<repo>` with inherited stdio
 *
 * Usage: dwn-git clone <did>/<repo> [-- <git-clone-args...>]
 *
 * @module
 */

import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cloneCommand(args: string[]): Promise<void> {
  const target = args[0];

  if (!target) {
    console.error('Usage: dwn-git clone <did>/<repo> [-- <git-clone-args...>]');
    console.error('');
    console.error('Examples:');
    console.error('  dwn-git clone did:dht:abc123/my-repo');
    console.error('  dwn-git clone did:dht:abc123/my-repo -- --depth 1');
    process.exit(1);
  }

  // Parse the target: expect "did:<method>:<id>/<repo>" format.
  const slashIdx = target.indexOf('/');
  if (slashIdx === -1 || !target.startsWith('did:')) {
    console.error(`Invalid target: "${target}"`);
    console.error('Expected format: did:<method>:<id>/<repo>');
    console.error('Example: did:dht:abc123/my-repo');
    process.exit(1);
  }

  const didPart = target.slice(0, slashIdx);
  const repoPart = target.slice(slashIdx + 1);

  if (didPart.split(':').length < 3) {
    console.error(`Invalid DID: "${didPart}"`);
    console.error('Expected format: did:<method>:<id>');
    process.exit(1);
  }

  if (!repoPart) {
    console.error('Missing repository name after DID.');
    console.error('Expected format: did:<method>:<id>/<repo>');
    process.exit(1);
  }

  // Collect any extra git args after `--`.
  const dashDashIdx = args.indexOf('--');
  const extraArgs = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : [];

  // Build the DID transport URL: `did::<did>/<repo>`
  const didUrl = `did::${didPart}/${repoPart}`;

  console.log(`Cloning ${didPart}/${repoPart} via DID transport...`);
  console.log('');

  // Spawn git clone with inherited stdio so the user sees progress.
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('git', ['clone', didUrl, ...extraArgs], {
      stdio : 'inherit',
      env   : process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 128));
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
