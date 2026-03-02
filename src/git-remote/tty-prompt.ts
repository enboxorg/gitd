/**
 * TTY password prompt for git helper processes.
 *
 * When Git invokes `git-remote-did` or `git-remote-did-credential`, it
 * owns stdin and stdout for the helper protocol.  This module opens
 * `/dev/tty` directly — the same technique used by `ssh`, `gpg`, and
 * `sudo` — so we can prompt the user for a vault password without
 * interfering with the git protocol streams.
 *
 * Falls back to `GITD_PASSWORD` if the env var is already set, or
 * returns `null` when no TTY is available (e.g. CI, piped input).
 *
 * @module
 */

import { closeSync, openSync, readSync, writeSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the vault password, prompting on `/dev/tty` if necessary.
 *
 * Resolution order:
 *   1. `GITD_PASSWORD` environment variable (non-interactive)
 *   2. Interactive prompt via `/dev/tty` (hidden input)
 *   3. `null` if no TTY is available
 *
 * @returns The password string, or `null` if unavailable.
 */
export function getVaultPassword(): string | null {
  const env = process.env.GITD_PASSWORD;
  if (env) { return env; }

  return promptTtyPassword('Vault password: ');
}

// ---------------------------------------------------------------------------
// TTY prompting
// ---------------------------------------------------------------------------

/**
 * Prompt for a password on `/dev/tty` with hidden input.
 *
 * Opens `/dev/tty` for both reading and writing, prints the prompt,
 * reads one line of input character-by-character (no echo), and returns
 * the result.  Returns `null` if `/dev/tty` cannot be opened (e.g.
 * headless CI, Windows without ConPTY).
 *
 * @param prompt - The prompt string to display (e.g. "Vault password: ")
 * @returns The entered string, or `null` if no TTY is available.
 */
function promptTtyPassword(prompt: string): string | null {
  let readFd: number;
  let writeFd: number;

  try {
    readFd = openSync('/dev/tty', 'r');
    writeFd = openSync('/dev/tty', 'w');
  } catch {
    // No controlling terminal — can't prompt.
    return null;
  }

  try {
    // Write the prompt.
    writeSync(writeFd, prompt);

    // Read character-by-character with no echo.
    // We use raw fd reads — one byte at a time — which avoids requiring
    // Node readline or setRawMode (neither works reliably on an fd that
    // isn't process.stdin).
    const buf = Buffer.alloc(1);
    let password = '';

    while (true) {
      const bytesRead = readSync(readFd, buf, 0, 1, null);
      if (bytesRead === 0) { break; } // EOF

      const ch = buf[0];

      // Enter (LF or CR) — done.
      if (ch === 0x0A || ch === 0x0D) {
        writeSync(writeFd, '\n');
        break;
      }

      // Ctrl-C — abort.
      if (ch === 0x03) {
        writeSync(writeFd, '\n');
        process.exit(130);
      }

      // Backspace / Delete.
      if (ch === 0x7F || ch === 0x08) {
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
        continue;
      }

      // Printable ASCII.
      if (ch >= 0x20) {
        password += String.fromCharCode(ch);
      }
    }

    return password;
  } finally {
    closeSync(readFd);
    closeSync(writeFd);
  }
}
