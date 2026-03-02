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

import { execSync } from 'node:child_process';
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
 * Opens `/dev/tty` for both reading and writing, disables terminal echo
 * via `stty -echo`, reads one line of input, restores echo, and returns
 * the result.  Returns `null` if `/dev/tty` cannot be opened (e.g.
 * headless CI, Windows without ConPTY).
 *
 * The terminal is left in cooked (line-buffered) mode — only the echo
 * flag is toggled.  This lets the terminal driver handle backspace and
 * line editing natively, which is more reliable across shells than
 * reading raw bytes.
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
    // Disable echo on the controlling terminal.  We shell out to `stty`
    // because Node/Bun don't expose `tcsetattr` and FFI adds complexity.
    // The `< /dev/tty` redirect ensures stty targets the right device
    // even when our stdin is owned by git.
    try {
      execSync('stty -echo < /dev/tty', { stdio: 'ignore' });
    } catch {
      // If stty fails (e.g. not available), continue anyway — the user
      // will see their password but at least the flow won't break.
    }

    // Write the prompt.
    writeSync(writeFd, prompt);

    // Read in cooked mode — the terminal driver handles line editing
    // (backspace, etc.) and delivers a complete line on Enter.
    const buf = Buffer.alloc(256);
    let password = '';

    while (true) {
      const bytesRead = readSync(readFd, buf, 0, buf.length, null);
      if (bytesRead === 0) { break; } // EOF

      password += buf.toString('utf8', 0, bytesRead);

      // Stop at the first newline.
      const nlIdx = password.indexOf('\n');
      if (nlIdx !== -1) {
        password = password.slice(0, nlIdx);
        break;
      }

      const crIdx = password.indexOf('\r');
      if (crIdx !== -1) {
        password = password.slice(0, crIdx);
        break;
      }
    }

    // Move to a new line (echo was off so Enter wasn't visible).
    writeSync(writeFd, '\n');

    return password;
  } finally {
    // Restore echo — critical to avoid leaving the terminal broken.
    try {
      execSync('stty echo < /dev/tty', { stdio: 'ignore' });
    } catch {
      // Best-effort restore.
    }

    closeSync(readFd);
    closeSync(writeFd);
  }
}
