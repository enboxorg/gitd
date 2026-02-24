/**
 * Parse DID URLs used with `git-remote-did`.
 *
 * Supported URL forms (all invoke `git-remote-did <remote> <url>`):
 *
 *   did::dht:abc123                → DID = did:dht:abc123, repo = undefined
 *   did::dht:abc123/my-repo       → DID = did:dht:abc123, repo = my-repo
 *   did://dht:abc123/my-repo      → DID = did:dht:abc123, repo = my-repo
 *
 * The double-colon form (`did::<address>`) is recommended because it avoids
 * URL-parsing ambiguity.  Git strips the `did::` prefix and passes
 * `<address>` as the URL argument.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed components of a DID remote URL. */
export type ParsedDidUrl = {
  /** Full DID URI, e.g. `did:dht:abc123xyz`. */
  did: string;

  /** Optional repository name from the path component. */
  repo?: string;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a DID remote URL into its components.
 *
 * @param url - The URL argument passed by Git to the remote helper.
 *              After stripping the transport prefix:
 *                `did::dht:abc123/repo` → Git passes `dht:abc123/repo`
 *                `did://dht:abc123/repo` → Git passes `did://dht:abc123/repo`
 */
export function parseDidUrl(url: string): ParsedDidUrl {
  let stripped = url;

  // Strip did:// prefix if present (the `://` form).
  if (stripped.startsWith('did://')) {
    stripped = stripped.slice('did://'.length);
  }

  // At this point, `stripped` is either:
  //   "dht:abc123"          (DID only)
  //   "dht:abc123/my-repo"  (DID + repo path)
  //   "web:example.com:path/my-repo"  (did:web)

  // Split on the first `/` to separate DID from repo path.
  const slashIdx = stripped.indexOf('/');

  let didSuffix: string;
  let repo: string | undefined;

  if (slashIdx === -1) {
    didSuffix = stripped;
  } else {
    didSuffix = stripped.slice(0, slashIdx);
    const pathPart = stripped.slice(slashIdx + 1);
    if (pathPart.length > 0) {
      repo = pathPart;
    }
  }

  // Reconstruct full DID URI.
  const did = `did:${didSuffix}`;

  // Basic validation.
  const parts = did.split(':');
  if (parts.length < 3 || parts[0] !== 'did' || parts[1].length === 0 || parts[2].length === 0) {
    throw new Error(`Invalid DID URL: "${url}" (parsed DID: "${did}")`);
  }

  return { did, repo };
}
