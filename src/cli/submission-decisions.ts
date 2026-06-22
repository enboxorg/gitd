import type { AgentContext } from './agent.js';
import type { RepoContext } from './repo-context.js';

export type SubmissionKind = 'issue' | 'patch';

export type SubmissionDecisionResult = {
  created : boolean;
  record? : any;
  status? : { code: number; detail?: string };
};

export async function recordIgnoredSubmission(
  ctx: AgentContext,
  repo: RepoContext,
  kind: SubmissionKind,
  submitterDid: string,
  submission: { id: string; contextId?: string },
  reason?: string,
): Promise<SubmissionDecisionResult> {
  const matchTags = {
    kind,
    decision           : 'ignored',
    submitterDid,
    submissionRecordId : submission.id,
  };
  const { records: existing } = await ctx.repo.records.query('repo/submissionDecision' as any, {
    filter: {
      contextId : repo.contextId,
      tags      : matchTags,
    },
  });
  if (existing.length > 0) {
    return { created: false, record: existing[0] };
  }

  const tags: Record<string, string> = { ...matchTags };
  if (submission.contextId) { tags.submissionContextId = submission.contextId; }

  const data: Record<string, string> = {
    ...tags,
    decidedBy : ctx.did,
    decidedAt : new Date().toISOString(),
  };
  if (reason) { data.reason = reason; }

  const { status, record } = await ctx.repo.records.create('repo/submissionDecision' as any, {
    data,
    tags,
    parentContextId: repo.contextId,
  } as any);

  return { created: status.code < 300, record, status };
}
