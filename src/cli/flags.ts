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

/** Check whether a boolean flag is present in argv. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Parse a port number string, validating that it's a valid TCP port.
 * Exits the process with an error if the value is not a valid port.
 *
 * @param value - The port string to parse
 * @returns A valid port number (1–65535)
 */
export function parsePort(value: string): number {
  const port = parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port number: '${value}'. Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}
