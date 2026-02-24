/**
 * GitHub API shim — `/users/:did` endpoint.
 *
 * Synthesizes a GitHub-style user object from a DID.  Since DIDs are
 * self-sovereign identifiers, we don't have profile data beyond the
 * DID itself — fields like `name`, `bio`, etc. are left empty.
 *
 * @module
 */

import type { JsonResponse } from './helpers.js';

import {
  buildApiUrl,
  jsonOk,
  numericId,
  toISODate,
} from './helpers.js';

// ---------------------------------------------------------------------------
// GET /users/:did
// ---------------------------------------------------------------------------

/**
 * Handle `GET /users/:did`.
 *
 * Returns a GitHub-style user profile JSON response.
 */
export async function handleGetUser(
  targetDid: string, url: URL,
): Promise<JsonResponse> {
  const baseUrl = buildApiUrl(url);
  const id = numericId(targetDid);

  const user = {
    login            : targetDid,
    id,
    node_id          : targetDid,
    avatar_url       : '',
    gravatar_id      : '',
    url              : `${baseUrl}/users/${targetDid}`,
    html_url         : `${baseUrl}/users/${targetDid}`,
    repos_url        : `${baseUrl}/users/${targetDid}/repos`,
    type             : 'User',
    site_admin       : false,
    name             : null,
    company          : null,
    blog             : '',
    location         : null,
    email            : null,
    hireable         : null,
    bio              : null,
    twitter_username : null,
    public_repos     : 0,
    public_gists     : 0,
    followers        : 0,
    following        : 0,
    created_at       : toISODate(undefined),
    updated_at       : toISODate(undefined),
  };

  return jsonOk(user);
}
