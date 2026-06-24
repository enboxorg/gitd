import { describe, expect, it } from 'bun:test';

import { getRepoContext } from '../src/cli/repo-context.js';

function repoRecord(name: string, defaultBranch: string): any {
  return {
    id        : `record-${name}`,
    contextId : `context-${name}`,
    tags      : { name, visibility: 'public' },
    data      : {
      json: async (): Promise<Record<string, unknown>> => ({
        name,
        defaultBranch,
        dwnEndpoints: [],
      }),
    },
  };
}

function agentContextWithRepos(records: any[]): any {
  return {
    did  : 'did:dht:repo-context-test',
    repo : {
      records: {
        query: async (_path: string, options?: any) => {
          const name = options?.filter?.tags?.name;
          return {
            records: name
              ? records.filter(record => record.tags.name === name)
              : records,
          };
        },
      },
    },
  } as any;
}

describe('repo context helpers', () => {
  it('includes the repo default branch when record data is readable', async () => {
    const ctx = agentContextWithRepos([repoRecord('demo-trunk', 'trunk')]);

    const repo = await getRepoContext(ctx, 'demo-trunk');

    expect(repo).toMatchObject({
      recordId      : 'record-demo-trunk',
      contextId     : 'context-demo-trunk',
      name          : 'demo-trunk',
      visibility    : 'public',
      defaultBranch : 'trunk',
    });
  });
});
