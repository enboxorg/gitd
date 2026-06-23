/**
 * Git receive-pack update parsing.
 *
 * A receive-pack request starts with pkt-line commands of the form:
 * `<old-oid> <new-oid> <ref-name>\0<capabilities>`.
 * The packfile follows after the flush packet.  Authorization only needs
 * the command header, not the pack payload.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One ref update requested by a git push. */
export type PushRefUpdate = {
  /** Previous object ID, or null when creating a ref. */
  oldTarget: string | null;

  /** New object ID, or null when deleting a ref. */
  newTarget: string | null;

  /** Full ref name, e.g. `refs/heads/main`. */
  refName: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse receive-pack update commands from a request body clone. */
export async function parseReceivePackUpdatesFromRequest(request: Request): Promise<PushRefUpdate[]> {
  if (!request.body) { return []; }
  const body = new Uint8Array(await request.arrayBuffer());
  return parseReceivePackUpdates(body);
}

/** Parse receive-pack update commands from raw pkt-line bytes. */
export function parseReceivePackUpdates(input: Uint8Array | string): PushRefUpdate[] {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const decoder = new TextDecoder();
  const updates: PushRefUpdate[] = [];

  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const lenText = decoder.decode(bytes.slice(offset, offset + 4));
    if (lenText === '0000') { break; }

    const len = Number.parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > bytes.length) {
      break;
    }

    const payload = decoder.decode(bytes.slice(offset + 4, offset + len));
    const update = parseUpdateLine(payload);
    if (!update) { break; }
    updates.push(update);

    offset += len;
  }

  return updates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseUpdateLine(line: string): PushRefUpdate | undefined {
  const command = line.split('\0', 1)[0].trimEnd();
  const match = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([^\s\0]+)$/i.exec(command);
  if (!match) { return undefined; }

  return {
    oldTarget : oidToTarget(match[1]),
    newTarget : oidToTarget(match[2]),
    refName   : match[3],
  };
}

function oidToTarget(oid: string): string | null {
  return /^0+$/.test(oid) ? null : oid.toLowerCase();
}
