/**
 * Small helpers for command-specific wizards.
 *
 * Commands still accept normal positional arguments for scripts. In an
 * interactive terminal, missing required positionals can be prompted without
 * accidentally treating flag values such as `--repo demo` as command input.
 *
 * @module
 */

export type InteractivePromptOptions = {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
};

export function shouldPromptForMissingInput(
  value: string | undefined,
  options: InteractivePromptOptions = {
    stdinIsTTY  : process.stdin.isTTY,
    stdoutIsTTY : process.stdout.isTTY,
  },
): boolean {
  return !value && Boolean(options.stdinIsTTY && options.stdoutIsTTY);
}

export function positionalArgs(args: readonly string[], flagsWithValue: ReadonlySet<string>): string[] {
  const values: string[] = [];
  let consumeNext = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (consumeNext) {
      consumeNext = false;
      continue;
    }

    if (arg === '--') {
      values.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      if (!arg.includes('=') && flagsWithValue.has(arg)) {
        consumeNext = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      if (flagsWithValue.has(arg)) {
        consumeNext = true;
      }
      continue;
    }

    values.push(arg);
  }

  return values;
}
