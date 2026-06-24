/**
 * `gitd doctor` — read-only diagnostics for local gitd setup.
 *
 * Checks the pieces users should not have to understand during normal use:
 * Git availability, command wrappers, credential helper config, profile
 * selection, repo config, and local helper status.
 *
 * @module
 */

import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DidDht, DidJwk, DidKey, DidWeb, UniversalResolver } from '@enbox/dids';

import { checkGit } from '../preflight.js';
import { flagValue } from '../flags.js';
import { getVersion } from '../../version.js';
import { parseDidUrl } from '../../git-remote/parse-url.js';
import { resolveAgentDwnEndpoints } from '../agent.js';
import { configPath, profileDataPath, readConfig, resolveProfile } from '../../profiles/config.js';
import { daemonLogPath, daemonStatus } from '../../daemon/lifecycle.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

type CheckCounters = {
  fail: number;
  warn: number;
};

const DEFAULT_BIN_DIR = join(homedir(), '.gitd', 'bin');
const REQUIRED_WRAPPERS = ['git-remote-did', 'git-remote-did-credential'] as const;
const DOCTOR_DID_RESOLUTION_TIMEOUT_MS = 5_000;
const DOCTOR_DWN_ENDPOINT_TIMEOUT_MS = 2_000;

export async function doctorCommand(args: string[]): Promise<void> {
  const counters: CheckCounters = { fail: 0, warn: 0 };
  const binDir = flagValue(args, '--bin-dir') ?? DEFAULT_BIN_DIR;
  const profileFlag = flagValue(args, '--profile');
  const profileName = resolveProfile(profileFlag) ?? undefined;

  console.log('gitd doctor');
  console.log('');

  checkVersion(counters);
  checkGitInstall(counters);
  checkPath(counters, binDir);
  checkWrappers(counters, binDir);
  checkCredentialHelper(counters);
  checkProfile(counters, profileName);
  await checkDwnEndpoints(counters);
  await checkRepoContext(counters);
  checkLocalHelper(counters, profileName);

  console.log('');
  if (counters.fail > 0) {
    console.log(`Found ${counters.fail} issue${counters.fail === 1 ? '' : 's'} that gitd repair may fix.`);
    console.log('Try: gitd repair');
    process.exitCode = 1;
    return;
  }

  if (counters.warn > 0) {
    console.log(`No blocking issues found. ${counters.warn} warning${counters.warn === 1 ? '' : 's'} reported.`);
    return;
  }

  console.log('All checked items look ready.');
}

function report(
  counters: CheckCounters,
  status: CheckStatus,
  name: string,
  detail: string,
): void {
  if (status === 'fail') { counters.fail++; }
  if (status === 'warn') { counters.warn++; }
  console.log(`[${status}] ${name}: ${detail}`);
}

function checkVersion(counters: CheckCounters): void {
  report(counters, 'ok', 'version', getVersion() ?? 'unknown');
}

function checkGitInstall(counters: CheckCounters): void {
  const git = checkGit();
  if (!git.installed) {
    report(counters, 'fail', 'git', 'not found on PATH');
    return;
  }
  if (!git.meetsMinimum) {
    report(counters, 'fail', 'git', `${git.version ?? 'unknown'} is older than required 2.28.0`);
    return;
  }
  report(counters, 'ok', 'git', git.version ?? 'installed');
}

function checkPath(counters: CheckCounters, binDir: string): void {
  if (isOnPath(binDir)) {
    report(counters, 'ok', 'PATH', `${binDir} is on PATH`);
    return;
  }

  report(counters, 'warn', 'PATH', `${binDir} is not on PATH for this shell`);
}

function checkWrappers(counters: CheckCounters, binDir: string): void {
  for (const name of REQUIRED_WRAPPERS) {
    const path = join(binDir, name);
    if (!existsSync(path)) {
      report(counters, 'fail', name, `missing at ${path}`);
      continue;
    }

    if (!isExecutable(path)) {
      report(counters, 'fail', name, `not executable at ${path}`);
      continue;
    }

    report(counters, 'ok', name, path);
  }
}

function checkCredentialHelper(counters: CheckCounters): void {
  const helpers = gitConfigGlobalAll('credential.helper');
  if (helpers.length === 0) {
    report(counters, 'fail', 'credential helper', 'not configured');
    return;
  }

  const gitdHelper = helpers.find((helper) => helper.includes('git-remote-did-credential'));
  if (!gitdHelper) {
    report(counters, 'fail', 'credential helper', `configured without gitd: ${helpers.join(', ')}`);
    return;
  }

  report(counters, 'ok', 'credential helper', gitdHelper);
}

function checkProfile(counters: CheckCounters, profileName?: string): void {
  const config = safeReadConfig();
  if (!config) {
    report(counters, 'warn', 'identity', `no config found at ${configPath()}`);
    return;
  }

  if (Object.keys(config.profiles).length === 0) {
    report(counters, 'warn', 'identity', 'none configured; run gitd auth login');
    return;
  }

  if (!profileName) {
    report(counters, 'warn', 'identity', 'multiple profiles exist and no default/profile was resolved');
    return;
  }

  const entry = config.profiles[profileName];
  if (!entry) {
    report(counters, 'fail', 'identity', `profile "${profileName}" not found in ${configPath()}`);
    return;
  }

  report(counters, 'ok', 'identity', `${profileName} (${entry.did})`);
  report(counters, existsSync(profileDataPath(profileName)) ? 'ok' : 'warn', 'identity data', profileDataPath(profileName));
}

async function checkDwnEndpoints(counters: CheckCounters): Promise<void> {
  const endpoints = resolveAgentDwnEndpoints();
  if (endpoints.length === 0) {
    report(counters, 'warn', 'DWN endpoint', 'none configured');
    return;
  }

  await Promise.all(endpoints.map(async (endpoint) => {
    const result = await probeDwnEndpoint(endpoint);
    report(counters, result.ok ? 'ok' : 'warn', 'DWN endpoint', result.detail);
  }));
}

async function checkRepoContext(counters: CheckCounters): Promise<void> {
  const inside = gitRevParseGitDir();
  if (!inside) {
    report(counters, 'warn', 'repo context', 'not inside a Git repository');
    return;
  }

  const repo = gitConfigLocal('--get', 'enbox.repo');
  const owner = gitConfigLocal('--get', 'enbox.owner');
  const profile = gitConfigLocal('--get', 'enbox.profile');
  const origin = gitConfigLocal('--get', 'remote.origin.url');

  if (repo && owner) {
    report(counters, 'ok', 'repo context', `${owner}/${repo}`);
  } else {
    report(counters, 'warn', 'repo context', 'missing enbox.owner or enbox.repo');
  }

  if (profile) {
    report(counters, 'ok', 'repo profile', profile);
  }

  if (origin?.startsWith('did::')) {
    await checkDidRemote(counters, origin);
  } else if (origin) {
    report(counters, 'warn', 'DID remote', `origin is ${origin}`);
  }
}

export function parseDoctorDidRemote(origin: string): ReturnType<typeof parseDidUrl> | null {
  if (origin.startsWith('did::')) {
    return parseDidUrl(origin.slice('did::'.length));
  }
  if (origin.startsWith('did://')) {
    return parseDidUrl(origin);
  }
  return null;
}

async function checkDidRemote(counters: CheckCounters, origin: string): Promise<void> {
  let parsed: ReturnType<typeof parseDidUrl> | null;
  try {
    parsed = parseDoctorDidRemote(origin);
  } catch (err) {
    report(counters, 'fail', 'DID remote', (err as Error).message);
    return;
  }

  if (!parsed) {
    report(counters, 'warn', 'DID remote', `origin is ${origin}`);
    return;
  }

  report(counters, 'ok', 'DID remote', `${parsed.did}${parsed.repo ? `/${parsed.repo}` : ''}`);

  const resolution = await inspectDidServices(parsed.did);
  report(counters, resolution.ok ? 'ok' : 'warn', 'DID resolution', resolution.detail);
}

function checkLocalHelper(counters: CheckCounters, profileName?: string): void {
  const status = daemonStatus({ profileName });
  if (!status.running) {
    report(counters, 'warn', 'local helper', `not running; log path ${daemonLogPath(profileName)}`);
    return;
  }

  report(counters, 'ok', 'local helper', `port ${status.port}, pid ${status.pid}, uptime ${status.uptime}`);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isOnPath(dir: string): boolean {
  return (process.env.PATH ?? '')
    .split(':')
    .some((entry) => resolve(entry) === resolve(dir));
}

function gitConfigGlobalAll(key: string): string[] {
  const result = spawnSync('git', ['config', '--global', '--get-all', key], {
    encoding : 'utf-8',
    stdio    : ['ignore', 'pipe', 'pipe'],
    timeout  : 2_000,
  });
  if (result.status !== 0) { return []; }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitConfigLocal(...args: string[]): string | undefined {
  const result = spawnSync('git', ['config', ...args], {
    encoding : 'utf-8',
    stdio    : ['ignore', 'pipe', 'pipe'],
    timeout  : 2_000,
  });
  const value = result.stdout?.trim();
  return result.status === 0 && value ? value : undefined;
}

function gitRevParseGitDir(): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--git-dir'], {
    encoding : 'utf-8',
    stdio    : ['ignore', 'pipe', 'pipe'],
    timeout  : 2_000,
  });
  const value = result.stdout?.trim();
  return result.status === 0 && value ? value : undefined;
}

function safeReadConfig(): ReturnType<typeof readConfig> | undefined {
  try {
    return readConfig();
  } catch {
    return undefined;
  }
}

type ProbeResult = {
  ok: boolean;
  detail: string;
};

async function probeDwnEndpoint(endpoint: string): Promise<ProbeResult> {
  try {
    const url = new URL(endpoint);
    const response = await fetch(url, {
      method : 'GET',
      signal : AbortSignal.timeout(DOCTOR_DWN_ENDPOINT_TIMEOUT_MS),
    });
    return {
      ok     : response.status < 500,
      detail : `${endpoint} returned HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      ok     : false,
      detail : `${endpoint} unreachable: ${(err as Error).message}`,
    };
  }
}

type DidInspection = {
  ok: boolean;
  detail: string;
};

let doctorResolver: UniversalResolver | undefined;

function getDoctorResolver(): UniversalResolver {
  doctorResolver ??= new UniversalResolver({
    didResolvers: [DidDht, DidJwk, DidWeb, DidKey],
  });
  return doctorResolver;
}

async function inspectDidServices(did: string): Promise<DidInspection> {
  try {
    const resolved = await Promise.race([
      getDoctorResolver().resolve(did),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${DOCTOR_DID_RESOLUTION_TIMEOUT_MS}ms`)), DOCTOR_DID_RESOLUTION_TIMEOUT_MS),
      ),
    ]);

    if (resolved.didResolutionMetadata.error) {
      return { ok: false, detail: `${did}: ${resolved.didResolutionMetadata.error}` };
    }

    const services = resolved.didDocument?.service ?? [];
    const serviceTypes = services.map((service) => service.type).join(', ') || '(none)';

    if (services.some((service) => service.type === 'GitTransport')) {
      return { ok: true, detail: `${did} services: ${serviceTypes}` };
    }

    if (services.some((service) => service.type === 'DecentralizedWebNode')) {
      return {
        ok     : false,
        detail : `${did} has DWN service but no GitTransport; local helper must be available for clone/fetch`,
      };
    }

    return { ok: false, detail: `${did} has no GitTransport service; services: ${serviceTypes}` };
  } catch (err) {
    return { ok: false, detail: `${did} could not be resolved: ${(err as Error).message}` };
  }
}
