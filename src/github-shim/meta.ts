/**
 * GitHub API shim - global utility endpoints.
 *
 * Provides GitHub-compatible public metadata, rate limit, emoji,
 * gitignore, license, and Markdown rendering endpoints used by generic
 * API clients before they touch repository-specific resources.
 *
 * @module
 */

import type { JsonResponse } from './helpers.js';

import {
  baseHeaders,
  buildApiUrl,
  jsonNotFound,
  jsonOk,
  jsonValidationError,
} from './helpers.js';

type GitignoreTemplate = {
  name : string;
  source : string;
};

type LicenseTemplate = {
  key : string;
  name : string;
  spdxId : string;
  body : string;
};

const GITIGNORE_TEMPLATES: GitignoreTemplate[] = [
  {
    name   : 'Node',
    source : [
      'node_modules/',
      'npm-debug.log*',
      'yarn-debug.log*',
      'yarn-error.log*',
      '.env',
      'dist/',
      '',
    ].join('\n'),
  },
  {
    name   : 'Python',
    source : [
      '__pycache__/',
      '*.py[cod]',
      '.venv/',
      'venv/',
      'dist/',
      'build/',
      '',
    ].join('\n'),
  },
  {
    name   : 'macOS',
    source : [
      '.DS_Store',
      '.AppleDouble',
      '.LSOverride',
      '',
    ].join('\n'),
  },
  {
    name   : 'VisualStudioCode',
    source : [
      '.vscode/*',
      '!.vscode/settings.json',
      '!.vscode/tasks.json',
      '!.vscode/launch.json',
      '',
    ].join('\n'),
  },
];

const LICENSES: LicenseTemplate[] = [
  {
    key    : 'mit',
    name   : 'MIT License',
    spdxId : 'MIT',
    body   : [
      'MIT License',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software.',
      '',
    ].join('\n'),
  },
  {
    key    : 'apache-2.0',
    name   : 'Apache License 2.0',
    spdxId : 'Apache-2.0',
    body   : [
      'Apache License',
      'Version 2.0, January 2004',
      '',
      'Licensed under the Apache License, Version 2.0 (the "License");',
      'you may not use this file except in compliance with the License.',
      '',
    ].join('\n'),
  },
  {
    key    : 'gpl-3.0',
    name   : 'GNU General Public License v3.0',
    spdxId : 'GPL-3.0',
    body   : [
      'GNU GENERAL PUBLIC LICENSE',
      'Version 3, 29 June 2007',
      '',
      'Everyone is permitted to copy and distribute verbatim copies',
      'of this license document, but changing it is not allowed.',
      '',
    ].join('\n'),
  },
  {
    key    : 'unlicense',
    name   : 'The Unlicense',
    spdxId : 'Unlicense',
    body   : [
      'This is free and unencumbered software released into the public domain.',
      '',
    ].join('\n'),
  },
];

function textOk(body: string, contentType: string): JsonResponse {
  return {
    status  : 200,
    headers : {
      ...baseHeaders(),
      'Content-Type'   : contentType,
      'Content-Length' : String(Buffer.byteLength(body)),
    },
    body,
  };
}

function normalizedLookup(value: string): string {
  return decodeURIComponent(value).toLowerCase();
}

function licenseResponse(license: LicenseTemplate, baseUrl: string, includeBody: boolean): Record<string, unknown> {
  const data: Record<string, unknown> = {
    key     : license.key,
    name    : license.name,
    spdx_id : license.spdxId,
    url     : `${baseUrl}/licenses/${license.key}`,
    node_id : `MDc6TGljZW5zZQ${Buffer.from(license.key).toString('base64url')}`,
  };
  if (includeBody) {
    data.html_url = `https://choosealicense.com/licenses/${license.key}/`;
    data.description = `${license.name} template.`;
    data.implementation = 'Create a LICENSE file in the root of your repository.';
    data.permissions = ['commercial-use', 'modifications', 'distribution'];
    data.conditions = ['include-copyright'];
    data.limitations = ['liability'];
    data.body = license.body;
    data.featured = true;
  }
  return data;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function renderMarkdownText(markdown: string): string {
  const blocks = markdown.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const html = blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) {
        return '';
      }

      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        return `<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`;
      }

      const lines = trimmed.split('\n');
      if (lines.every(line => line.startsWith('- '))) {
        const items = lines.map(line => `<li>${renderInlineMarkdown(line.slice(2).trim())}</li>`).join('');
        return `<ul>${items}</ul>`;
      }

      return `<p>${renderInlineMarkdown(lines.join('\n'))}</p>`;
    })
    .filter(Boolean);

  return html.join('\n');
}

function rateBucket(limit: number, used = 0): Record<string, number> {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    reset,
  };
}

export function handleGitHubApiRoot(url: URL): JsonResponse {
  const baseUrl = buildApiUrl(url);
  return jsonOk({
    current_user_url              : `${baseUrl}/user`,
    code_search_url               : `${baseUrl}/search/code?q={query}{&page,per_page,sort,order}`,
    commit_search_url             : `${baseUrl}/search/commits?q={query}{&page,per_page,sort,order}`,
    emojis_url                    : `${baseUrl}/emojis`,
    followers_url                 : `${baseUrl}/user/followers`,
    following_url                 : `${baseUrl}/user/following{/target}`,
    issue_search_url              : `${baseUrl}/search/issues?q={query}{&page,per_page,sort,order}`,
    label_search_url              : `${baseUrl}/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
    notifications_url             : `${baseUrl}/notifications`,
    organization_url              : `${baseUrl}/orgs/{org}`,
    organization_repositories_url : `${baseUrl}/orgs/{org}/repos{?type,page,per_page,sort}`,
    organization_teams_url        : `${baseUrl}/orgs/{org}/teams`,
    rate_limit_url                : `${baseUrl}/rate_limit`,
    repository_url                : `${baseUrl}/repos/{owner}/{repo}`,
    repository_search_url         : `${baseUrl}/search/repositories?q={query}{&page,per_page,sort,order}`,
    current_user_repositories_url : `${baseUrl}/user/repos{?type,page,per_page,sort}`,
    starred_url                   : `${baseUrl}/user/starred{/owner}{/repo}`,
    topic_search_url              : `${baseUrl}/search/topics?q={query}{&page,per_page}`,
    user_url                      : `${baseUrl}/users/{user}`,
    user_organizations_url        : `${baseUrl}/user/orgs`,
    user_repositories_url         : `${baseUrl}/users/{user}/repos{?type,page,per_page,sort}`,
    user_search_url               : `${baseUrl}/search/users?q={query}{&page,per_page,sort,order}`,
  });
}

export function handleGetMeta(url: URL): JsonResponse {
  const host = new URL(buildApiUrl(url)).host;
  return jsonOk({
    verifiable_password_authentication : false,
    ssh_key_fingerprints               : {},
    ssh_keys                           : [],
    hooks                              : [],
    web                                : [],
    api                                : [],
    git                                : [],
    packages                           : [],
    pages                              : [],
    importer                           : [],
    actions                            : [],
    dependabot                         : [],
    copilot                            : [],
    domains                            : {
      website  : [host],
      api      : [host],
      packages : [host],
    },
  });
}

export function handleGetApiVersions(): JsonResponse {
  return jsonOk(['2022-11-28', '2026-03-10']);
}

export function handleGetZen(): JsonResponse {
  return textOk('Design for decentralization.', 'text/plain; charset=utf-8');
}

export function handleGetRateLimit(): JsonResponse {
  const core = rateBucket(5000, 1);
  return jsonOk({
    resources: {
      core,
      search                      : rateBucket(30),
      code_search                 : rateBucket(10),
      graphql                     : rateBucket(5000),
      integration_manifest        : rateBucket(5000),
      dependency_snapshots        : rateBucket(100),
      dependency_sbom             : rateBucket(100),
      code_scanning_upload        : rateBucket(500),
      actions_runner_registration : rateBucket(10000),
      scim                        : rateBucket(15000),
    },
    rate: core,
  });
}

export function handleGetEmojis(): JsonResponse {
  const base = 'https://github.githubassets.com/images/icons/emoji/unicode';
  return jsonOk({
    '+1'             : `${base}/1f44d.png?v8`,
    '-1'             : `${base}/1f44e.png?v8`,
    heart            : `${base}/2764.png?v8`,
    eyes             : `${base}/1f440.png?v8`,
    rocket           : `${base}/1f680.png?v8`,
    white_check_mark : `${base}/2705.png?v8`,
  });
}

export function handleListGitignoreTemplates(): JsonResponse {
  return jsonOk(GITIGNORE_TEMPLATES.map(template => template.name));
}

export function handleGetGitignoreTemplate(name: string): JsonResponse {
  const template = GITIGNORE_TEMPLATES.find(item => item.name.toLowerCase() === normalizedLookup(name));
  if (!template) {
    return jsonNotFound(`Gitignore template '${decodeURIComponent(name)}' not found.`);
  }

  return jsonOk({
    name   : template.name,
    source : template.source,
  });
}

export function handleListLicenses(url: URL): JsonResponse {
  const baseUrl = buildApiUrl(url);
  return jsonOk(LICENSES.map(license => licenseResponse(license, baseUrl, false)));
}

export function handleGetLicense(licenseKey: string, url: URL): JsonResponse {
  const normalized = normalizedLookup(licenseKey);
  const license = LICENSES.find(item => item.key === normalized || item.spdxId.toLowerCase() === normalized);
  if (!license) {
    return jsonNotFound(`License '${decodeURIComponent(licenseKey)}' not found.`);
  }

  return jsonOk(licenseResponse(license, buildApiUrl(url), true));
}

export function handleRenderMarkdown(reqBody: Record<string, unknown>): JsonResponse {
  if (typeof reqBody.text !== 'string') {
    return jsonValidationError('Validation Failed: text is required.');
  }

  if (reqBody.mode !== undefined && reqBody.mode !== 'markdown' && reqBody.mode !== 'gfm') {
    return jsonValidationError('Validation Failed: mode must be markdown or gfm.');
  }

  return textOk(renderMarkdownText(reqBody.text), 'text/html; charset=utf-8');
}

export function handleRenderRawMarkdown(options: { rawBody?: Uint8Array }): JsonResponse {
  const body = options.rawBody ?? new Uint8Array();
  if (body.byteLength > 400 * 1024) {
    return jsonValidationError('Validation Failed: Markdown content must be 400 KB or less.');
  }

  return textOk(renderMarkdownText(Buffer.from(body).toString('utf-8')), 'text/html; charset=utf-8');
}
