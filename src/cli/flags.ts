/**
 * Shared CLI argument helpers.
 *
 * @module
 */

/** Extract the value following a flag in argv (e.g. `--port 8080`). */
export function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) { return undefined; }
  return args[idx + 1];
}
