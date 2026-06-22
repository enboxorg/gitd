/**
 * GitHub API compatibility shim — HTTP server and router.
 *
 * Translates GitHub REST API v3 requests into DWN queries / writes and
 * returns GitHub-compatible JSON responses.  This allows existing tools
 * that speak the GitHub API (VS Code extensions, `gh` CLI, CI/CD
 * systems) to interact with any DWN-enabled git forge.
 *
 * Read endpoints (GET):
 *   GET  /                                           API root links
 *   GET  /meta                                      API metadata
 *   GET  /versions                                  Supported API versions
 *   GET  /zen                                       Status phrase
 *   GET  /rate_limit                                Rate limit status
 *   GET  /emojis                                    Emoji map
 *   GET  /gists                                    Authenticated user's gists
 *   GET  /gists/public                             Public gists visible to local actor
 *   GET  /gists/starred                            Authenticated user's starred gists
 *   GET  /gists/:gist_id                           Gist detail
 *   GET  /gists/:gist_id/:sha                      Gist revision detail
 *   GET  /gists/:gist_id/commits                   Gist commits
 *   GET  /gists/:gist_id/comments                  Gist comments
 *   GET  /gists/:gist_id/comments/:comment_id      Gist comment detail
 *   GET  /gists/:gist_id/forks                     Gist forks
 *   GET  /gists/:gist_id/raw/:filename             Raw gist file content
 *   GET  /gists/:gist_id/star                      Check gist star
 *   GET  /gitignore/templates                       Gitignore templates
 *   GET  /gitignore/templates/:name                 Gitignore template
 *   GET  /licenses                                  Common licenses
 *   GET  /licenses/:license                         License detail
 *   GET  /events                                    Public activity events
 *   GET  /repositories                              Public repositories
 *   GET  /networks/:did/:repo/events                Network repository events
 *   GET  /repos/:did/:repo                          Repository info
 *   GET  /repos/:did/:repo/events                   Repository events
 *   GET  /repos/:did/:repo/activity                 Repository activity history
 *   GET  /repos/:did/:repo/forks                    List repository forks
 *   GET  /repos/:did/:repo/readme                   Repository README
 *   GET  /repos/:did/:repo/readme/:dir              Repository README for a directory
 *   GET  /repos/:did/:repo/license                  Repository license
 *   GET  /repos/:did/:repo/contents[/path]          Repository git tree / metadata contents
 *   GET  /repos/:did/:repo/raw/:ref/:path           Repository raw file content
 *   GET  /repos/:did/:repo/tarball[/:ref]           Repository tar archive
 *   GET  /repos/:did/:repo/zipball[/:ref]           Repository zip archive
 *   GET  /repos/:did/:repo/branches                 List branches
 *   GET  /repos/:did/:repo/branches/:branch         Branch detail
 *   GET  /repos/:did/:repo/branches/:branch/protection Branch protection
 *   GET  /repos/:did/:repo/branches/:branch/protection/required_status_checks Status check protection
 *   GET  /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Status check contexts
 *   GET  /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews Pull request review protection
 *   GET  /repos/:did/:repo/tags                     List tags
 *   GET  /repos/:did/:repo/teams                    Repository teams
 *   GET  /repos/:did/:repo/git/ref/:ref             Git ref detail
 *   GET  /repos/:did/:repo/git/matching-refs/:ref   Matching git refs
 *   GET  /repos/:did/:repo/git/blobs/:sha           Git blob object
 *   GET  /repos/:did/:repo/git/trees/:sha           Git tree object
 *   GET  /repos/:did/:repo/git/commits/:sha         Low-level git commit object
 *   GET  /repos/:did/:repo/git/tags/:sha            Low-level git tag object
 *   GET  /repos/:did/:repo/community/profile        Community profile metrics
 *   GET  /repos/:did/:repo/contributors             List repository contributors
 *   GET  /repos/:did/:repo/commits                  List repository commits
 *   GET  /repos/:did/:repo/commits/:ref/comments    Commit comments for commit
 *   GET  /repos/:did/:repo/commits/:ref             Repository commit object
 *   GET  /repos/:did/:repo/comments                 List repository commit comments
 *   GET  /repos/:did/:repo/comments/:id             Commit comment detail
 *   GET  /repos/:did/:repo/comments/:id/reactions   Commit comment reactions
 *   GET  /repos/:did/:repo/compare/:base...:head    Compare commits
 *   GET  /repos/:did/:repo/compare/:base...:head.diff Compare commit diff
 *   GET  /repos/:did/:repo/compare/:base...:head.patch Compare commit patch
 *   GET  /repos/:did/:repo/stats/code_frequency     Weekly code frequency stats
 *   GET  /repos/:did/:repo/stats/commit_activity    Weekly commit activity stats
 *   GET  /repos/:did/:repo/stats/contributors       Contributor activity stats
 *   GET  /repos/:did/:repo/stats/participation      Weekly participation stats
 *   GET  /repos/:did/:repo/stats/punch_card         Hourly commit punch card stats
 *   GET  /repos/:did/:repo/traffic/clones           Repository clone traffic
 *   GET  /repos/:did/:repo/traffic/popular/paths    Popular repository paths
 *   GET  /repos/:did/:repo/traffic/popular/referrers Popular repository referrers
 *   GET  /repos/:did/:repo/traffic/views            Repository view traffic
 *   GET  /repos/:did/:repo/topics                   Repository topics
 *   GET  /repos/:did/:repo/languages                Repository languages
 *   GET  /repos/:did/:repo/issue-types              Repository issue types
 *   GET  /repos/:did/:repo/properties/values        Repository custom property values
 *   GET  /repos/:did/:repo/codeowners/errors        Repository CODEOWNERS syntax errors
 *   GET  /repos/:did/:repo/hash-algorithm           Repository git hash algorithm
 *   GET  /repos/:did/:repo/attestations/:subject_digest Repository artifact attestations
 *   GET  /repos/:did/:repo/keys                     List deploy keys
 *   GET  /repos/:did/:repo/keys/:key_id             Deploy key detail
 *   GET  /repos/:did/:repo/autolinks                List repository autolinks
 *   GET  /repos/:did/:repo/autolinks/:autolink_id   Repository autolink detail
 *   GET  /repos/:did/:repo/interaction-limits       Repository interaction restrictions
 *   GET  /repos/:did/:repo/vulnerability-alerts     Repository vulnerability alerts status
 *   GET  /repos/:did/:repo/automated-security-fixes Dependabot security updates status
 *   GET  /repos/:did/:repo/immutable-releases       Repository immutable releases status
 *   GET  /repos/:did/:repo/private-vulnerability-reporting Private vulnerability reporting status
 *   GET  /repos/:did/:repo/security-advisories Repository security advisories
 *   GET  /repos/:did/:repo/security-advisories/:ghsa_id Repository security advisory
 *   GET  /repos/:did/:repo/secret-scanning/alerts   Repository secret scanning alerts
 *   GET  /repos/:did/:repo/secret-scanning/alerts/:alert_number Repository secret scanning alert
 *   GET  /repos/:did/:repo/secret-scanning/alerts/:alert_number/locations Repository secret scanning alert locations
 *   GET  /repos/:did/:repo/secret-scanning/scan-history Repository secret scanning scan history
 *   GET  /repos/:did/:repo/code-scanning/alerts     Repository code scanning alerts
 *   GET  /repos/:did/:repo/code-scanning/alerts/:alert_number Repository code scanning alert
 *   GET  /repos/:did/:repo/code-scanning/alerts/:alert_number/instances Repository code scanning alert instances
 *   GET  /repos/:did/:repo/dependabot/alerts        Repository Dependabot alerts
 *   GET  /repos/:did/:repo/dependabot/alerts/:alert_number Repository Dependabot alert
 *   GET  /repos/:did/:repo/dependency-graph/sbom    Repository SPDX SBOM
 *   GET  /repos/:did/:repo/dependency-graph/sbom/generate-report Request repository SBOM generation
 *   GET  /repos/:did/:repo/dependency-graph/sbom/fetch-report/:sbom_uuid Fetch generated repository SBOM report
 *   GET  /repos/:did/:repo/rules/branches/:branch   Active branch rules
 *   GET  /repos/:did/:repo/rulesets/rule-suites     Repository rule suites
 *   GET  /repos/:did/:repo/rulesets/rule-suites/:rule_suite_id Repository rule suite
 *   GET  /repos/:did/:repo/rulesets                 Repository rulesets
 *   GET  /repos/:did/:repo/rulesets/:ruleset_id     Repository ruleset detail
 *   GET  /repos/:did/:repo/rulesets/:ruleset_id/history Repository ruleset history
 *   GET  /repos/:did/:repo/rulesets/:ruleset_id/history/:version_id Repository ruleset version
 *   GET  /repos/:did/:repo/assignees                List assignable users
 *   GET  /repos/:did/:repo/assignees/:did           Check assignable user
 *   GET  /repos/:did/:repo/collaborators            List collaborators
 *   GET  /repos/:did/:repo/collaborators/:did       Check collaborator
 *   GET  /repos/:did/:repo/collaborators/:did/permission Collaborator permission
 *   GET  /repos/:did/:repo/commits/:ref/status      Combined commit status
 *   GET  /repos/:did/:repo/commits/:ref/statuses    Commit statuses
 *   GET  /repos/:did/:repo/commits/:ref/check-suites Check suites for ref
 *   GET  /repos/:did/:repo/commits/:ref/check-runs Check runs for ref
 *   GET  /repos/:did/:repo/check-suites/:id         Check suite detail
 *   GET  /repos/:did/:repo/check-suites/:id/check-runs Check runs in suite
 *   GET  /repos/:did/:repo/check-runs/:id           Check run detail
 *   GET  /repos/:did/:repo/check-runs/:id/annotations Check run annotations
 *   GET  /repos/:did/:repo/actions/artifacts        List workflow artifacts
 *   GET  /repos/:did/:repo/actions/artifacts/:artifact_id Artifact detail
 *   GET  /repos/:did/:repo/actions/artifacts/:artifact_id/:archive_format Download artifact
 *   GET  /repos/:did/:repo/actions/cache/retention-limit Repository Actions cache retention limit
 *   GET  /repos/:did/:repo/actions/cache/storage-limit Repository Actions cache storage limit
 *   GET  /repos/:did/:repo/actions/cache/usage      Repository Actions cache usage
 *   GET  /repos/:did/:repo/actions/caches           Repository Actions caches
 *   GET  /repos/:did/:repo/actions/permissions      Repository Actions permissions
 *   GET  /repos/:did/:repo/actions/permissions/selected-actions Repository allowed Actions settings
 *   GET  /repos/:did/:repo/actions/permissions/workflow Repository default workflow permissions
 *   GET  /repos/:did/:repo/actions/secrets          Repository Actions secrets
 *   GET  /repos/:did/:repo/actions/secrets/public-key Repository Actions secrets public key
 *   GET  /repos/:did/:repo/actions/secrets/:name    Repository Actions secret
 *   GET  /repos/:did/:repo/actions/variables        Repository Actions variables
 *   GET  /repos/:did/:repo/actions/variables/:name  Repository Actions variable
 *   GET  /repos/:did/:repo/actions/workflows        List workflows
 *   GET  /repos/:did/:repo/actions/workflows/:workflow_id Workflow detail
 *   GET  /repos/:did/:repo/actions/workflows/:workflow_id/runs Workflow runs for workflow
 *   GET  /repos/:did/:repo/actions/workflows/:workflow_id/timing Workflow usage
 *   GET  /repos/:did/:repo/actions/runs             List workflow runs
 *   GET  /repos/:did/:repo/actions/runs/:run_id     Workflow run detail
 *   GET  /repos/:did/:repo/actions/runs/:run_id/attempts/:attempt_number Workflow run attempt
 *   GET  /repos/:did/:repo/actions/runs/:run_id/attempts/:attempt_number/logs Workflow run attempt logs
 *   GET  /repos/:did/:repo/actions/runs/:run_id/logs Download workflow run logs
 *   GET  /repos/:did/:repo/actions/runs/:run_id/artifacts Workflow run artifacts
 *   GET  /repos/:did/:repo/actions/runs/:run_id/jobs Workflow run jobs
 *   GET  /repos/:did/:repo/actions/runs/:run_id/timing Workflow run usage
 *   GET  /repos/:did/:repo/actions/jobs/:job_id/logs Download workflow job logs
 *   GET  /repos/:did/:repo/actions/jobs/:job_id     Workflow job detail
 *   GET  /repos/:did/:repo/stargazers               Repository stargazers
 *   GET  /repos/:did/:repo/subscribers              Repository watchers/subscribers
 *   GET  /repos/:did/:repo/subscription             Authenticated repository subscription
 *   GET  /repos/:did/:repo/hooks                    Repository webhooks
 *   GET  /repos/:did/:repo/hooks/:id                Repository webhook
 *   GET  /repos/:did/:repo/hooks/:id/config         Repository webhook configuration
 *   GET  /repos/:did/:repo/hooks/:id/deliveries     Repository webhook deliveries
 *   GET  /repos/:did/:repo/hooks/:id/deliveries/:delivery_id Repository webhook delivery
 *   GET  /repos/:did/:repo/labels                   Repository labels
 *   GET  /repos/:did/:repo/labels/:name             Repository label detail
 *   GET  /repos/:did/:repo/milestones               Repository milestones
 *   GET  /repos/:did/:repo/milestones/:number       Milestone detail
 *   GET  /repos/:did/:repo/milestones/:number/labels Labels for issues in milestone
 *   GET  /issues                                    Assigned issues across visible repositories
 *   GET  /user/issues                               Authenticated user's issues
 *   GET  /orgs/:org/issues                          Organization issues
 *   GET  /repos/:did/:repo/issues                   List issues
 *   GET  /repos/:did/:repo/issues/events            List repository issue events
 *   GET  /repos/:did/:repo/issues/events/:id        Issue event detail
 *   GET  /repos/:did/:repo/issues/comments          List repository issue comments
 *   GET  /repos/:did/:repo/issues/comments/:id      Issue comment detail
 *   GET  /repos/:did/:repo/issues/comments/:id/reactions Issue comment reactions
 *   GET  /repos/:did/:repo/issues/:number           Issue detail
 *   GET  /repos/:did/:repo/issues/:number/comments  Issue comments
 *   GET  /repos/:did/:repo/issues/:number/events    Issue events
 *   GET  /repos/:did/:repo/issues/:number/timeline  Issue timeline
 *   GET  /repos/:did/:repo/issues/:number/dependencies/blocked_by Issue dependencies blocking the issue
 *   GET  /repos/:did/:repo/issues/:number/dependencies/blocking Issue dependencies blocked by the issue
 *   GET  /repos/:did/:repo/issues/:number/parent    Issue parent
 *   GET  /repos/:did/:repo/issues/:number/sub_issues Issue sub-issues
 *   GET  /repos/:did/:repo/issues/:number/issue-field-values Issue field values
 *   GET  /repos/:did/:repo/issues/:number/reactions Issue reactions
 *   GET  /repos/:did/:repo/issues/:number/labels    Issue labels
 *   GET  /repos/:did/:repo/pulls                    List pull requests
 *   GET  /repos/:did/:repo/pulls/:number            Pull request detail
 *   GET  /repos/:did/:repo/pulls/:number.diff       Pull request diff
 *   GET  /repos/:did/:repo/pulls/:number.patch      Pull request patch
 *   GET  /repos/:did/:repo/pulls/:number/commits    Pull request commits
 *   GET  /repos/:did/:repo/pulls/:number/comments   Pull request review comments
 *   GET  /repos/:did/:repo/pulls/:number/files      Pull request files
 *   GET  /repos/:did/:repo/pulls/:number/merge      Check if pull request has been merged
 *   GET  /repos/:did/:repo/pulls/:number/requested_reviewers Pull request review requests
 *   GET  /repos/:did/:repo/pulls/:number/reviews    Pull request reviews
 *   GET  /repos/:did/:repo/pulls/:number/reviews/:id Pull request review
 *   GET  /repos/:did/:repo/pulls/:number/reviews/:id/comments Pull request review comments
 *   GET  /repos/:did/:repo/pulls/comments           Repository pull review comments
 *   GET  /repos/:did/:repo/pulls/comments/:id       Pull request review comment
 *   GET  /repos/:did/:repo/pulls/comments/:id/reactions Pull request review comment reactions
 *   GET  /repos/:did/:repo/releases                 List releases
 *   GET  /repos/:did/:repo/releases/latest          Latest published full release
 *   GET  /repos/:did/:repo/releases/:id             Release detail
 *   GET  /repos/:did/:repo/releases/:id/reactions   Release reactions
 *   GET  /repos/:did/:repo/releases/:id/assets      Release assets
 *   GET  /repos/:did/:repo/releases/assets/:id      Release asset metadata
 *   GET  /repos/:did/:repo/releases/assets/:id/download Release asset bytes
 *   GET  /repos/:did/:repo/releases/download/:tag/:asset Release asset download
 *   GET  /repos/:did/:repo/releases/tags/:tag       Release by tag
 *   GET  /repos/:did/:repo/environments             List deployment environments
 *   GET  /repos/:did/:repo/environments/:name        Deployment environment detail
 *   GET  /repos/:did/:repo/environments/:name/secrets Deployment environment secrets
 *   GET  /repos/:did/:repo/environments/:name/secrets/public-key Deployment environment secrets public key
 *   GET  /repos/:did/:repo/environments/:name/secrets/:secret_name Deployment environment secret
 *   GET  /repos/:did/:repo/environments/:name/variables Deployment environment variables
 *   GET  /repos/:did/:repo/environments/:name/variables/:variable_name Deployment environment variable
 *   GET  /repos/:did/:repo/deployments              List deployments
 *   GET  /repos/:did/:repo/deployments/:id          Deployment detail
 *   GET  /repos/:did/:repo/deployments/:id/statuses Deployment statuses
 *   GET  /repos/:did/:repo/deployments/:id/statuses/:status_id Deployment status
 *   GET  /repos/:did/:repo/pages                    GitHub Pages site
 *   GET  /repos/:did/:repo/pages/builds             GitHub Pages builds
 *   GET  /repos/:did/:repo/pages/builds/latest      Latest GitHub Pages build
 *   GET  /repos/:did/:repo/pages/builds/:build_id   GitHub Pages build detail
 *   GET  /repos/:did/:repo/pages/deployments/:id    GitHub Pages deployment status
 *   GET  /repos/:did/:repo/pages/deployments/:id/status GitHub Pages deployment status URL
 *   GET  /repos/:did/:repo/pages/health             GitHub Pages DNS health check
 *   GET  /notifications                             Authenticated user's notifications
 *   GET  /notifications/threads/:id                 Notification thread
 *   GET  /notifications/threads/:id/subscription    Notification thread subscription
 *   GET  /organizations                             Public organizations
 *   GET  /orgs/:org                                 Organization profile
 *   GET  /orgs/:org/members                         Organization members
 *   GET  /orgs/:org/members/:did                    Check organization membership
 *   GET  /orgs/:org/memberships/:did                Organization membership detail
 *   GET  /orgs/:org/failed_invitations              Failed organization invitations
 *   GET  /orgs/:org/invitations                     Pending organization invitations
 *   GET  /orgs/:org/invitations/:id/teams           Organization invitation teams
 *   GET  /orgs/:org/blocks                          Organization blocked users
 *   GET  /orgs/:org/blocks/:username                 Check organization blocked user
 *   GET  /orgs/:org/hooks                           Organization webhooks
 *   GET  /orgs/:org/hooks/:id                       Organization webhook
 *   GET  /orgs/:org/hooks/:id/config                Organization webhook configuration
 *   GET  /orgs/:org/hooks/:id/deliveries            Organization webhook deliveries
 *   GET  /orgs/:org/hooks/:id/deliveries/:delivery_id Organization webhook delivery
 *   GET  /orgs/:org/properties/schema               Organization custom property schema
 *   GET  /orgs/:org/properties/schema/:property      Organization custom property
 *   GET  /orgs/:org/properties/values               Organization repository custom property values
 *   GET  /orgs/:org/issue-fields                  Organization issue fields
 *   GET  /orgs/:org/issue-types                   Organization issue types
 *   GET  /orgs/:org/outside_collaborators           Outside collaborators
 *   GET  /orgs/:org/public_members                  Public organization members
 *   GET  /orgs/:org/public_members/:did              Check public organization membership
 *   GET  /orgs/:org/repos                           Organization repositories
 *   GET  /orgs/:org/code-scanning/alerts            Organization code scanning alerts
 *   GET  /orgs/:org/dependabot/alerts               Organization Dependabot alerts
 *   GET  /orgs/:org/secret-scanning/alerts          Organization secret scanning alerts
 *   GET  /orgs/:org/security-advisories             Organization repository security advisories
 *   GET  /orgs/:org/teams                           Organization teams
 *   GET  /orgs/:org/teams/:team_slug                Organization team
 *   GET  /orgs/:org/teams/:team_slug/teams          Child organization teams
 *   GET  /orgs/:org/teams/:team_slug/invitations    Pending team invitations
 *   GET  /orgs/:org/teams/:team_slug/members        Organization team members
 *   GET  /orgs/:org/teams/:team_slug/members/:did   Check team membership
 *   GET  /orgs/:org/teams/:team_slug/memberships/:did Get team membership
 *   GET  /orgs/:org/teams/:team_slug/repos          Team repositories
 *   GET  /orgs/:org/teams/:team_slug/repos/:did/:repo Check team repository permission
 *   GET  /organizations/:org_id/team/:team_id       Organization team by numeric ID
 *   GET  /organizations/:org_id/team/:team_id/teams Child organization teams by numeric ID
 *   GET  /organizations/:org_id/team/:team_id/invitations Pending team invitations by numeric ID
 *   GET  /organizations/:org_id/team/:team_id/members Organization team members by numeric ID
 *   GET  /organizations/:org_id/team/:team_id/memberships/:did Get team membership by numeric ID
 *   GET  /organizations/:org_id/team/:team_id/repos Team repositories by numeric ID
 *   GET  /organizations/:org_id/team/:team_id/repos/:did/:repo Check team repository permission by numeric ID
 *   GET  /teams/:team_id                            Legacy team by numeric ID
 *   GET  /teams/:team_id/teams                      Legacy child organization teams by numeric ID
 *   GET  /teams/:team_id/invitations                Legacy pending team invitations by numeric ID
 *   GET  /teams/:team_id/members                    Legacy organization team members by numeric ID
 *   GET  /teams/:team_id/members/:did               Legacy check team membership by numeric ID
 *   GET  /teams/:team_id/memberships/:did           Legacy get team membership by numeric ID
 *   GET  /teams/:team_id/repos                      Legacy team repositories by numeric ID
 *   GET  /teams/:team_id/repos/:did/:repo           Legacy check team repository permission by numeric ID
 *   GET  /repos/:did/:repo/notifications            Repository notifications
 *   GET  /search/code                               Search code
 *   GET  /search/commits                            Search commits
 *   GET  /search/issues                             Search issues and pull requests
 *   GET  /search/labels                             Search repository labels
 *   GET  /search/repositories                       Search repositories
 *   GET  /search/topics                             Search topics
 *   GET  /search/users                              Search users
 *   GET  /user                                      Authenticated user profile
 *   GET  /user/repos                                Authenticated user's repositories
 *   GET  /user/orgs                                 Authenticated user's organizations
 *   GET  /user/memberships/orgs                     Authenticated user's organization memberships
 *   GET  /user/memberships/orgs/:org                Authenticated user's organization membership
 *   GET  /user/teams                                Authenticated user's teams
 *   GET  /user/emails                               Authenticated user's email addresses
 *   GET  /user/public_emails                        Authenticated user's public email addresses
 *   GET  /user/gpg_keys                             Authenticated user's GPG keys
 *   GET  /user/gpg_keys/:key_id                     Authenticated user's GPG key
 *   GET  /user/social_accounts                      Authenticated user's social accounts
 *   GET  /user/keys                                 Authenticated user's SSH keys
 *   GET  /user/keys/:key_id                         Authenticated user's SSH key
 *   GET  /user/ssh_signing_keys                     Authenticated user's SSH signing keys
 *   GET  /user/ssh_signing_keys/:key_id             Authenticated user's SSH signing key
 *   GET  /user/blocks                               Authenticated user's blocked users
 *   GET  /user/blocks/:did                          Check authenticated user's blocked user
 *   GET  /user/followers                            Authenticated user's followers
 *   GET  /user/following                            Authenticated user's followed users
 *   GET  /user/following/:did                       Check authenticated user's follow
 *   GET  /user/starred                              Authenticated user's starred repos
 *   GET  /user/starred/:did/:repo                   Check authenticated user's star
 *   GET  /user/subscriptions                        Authenticated user's watched repos
 *   GET  /user/:account_id                          User profile by numeric account ID
 *   GET  /users/:did/followers                      User followers
 *   GET  /users/:did/following                      User followed users
 *   GET  /users/:did/following/:target_did          Check if a user follows another
 *   GET  /users/:did/events                         User events
 *   GET  /users/:did/events/public                  User public events
 *   GET  /users/:did/received_events                User received events
 *   GET  /users/:did/received_events/public         User public received events
 *   GET  /users/:did/repos                          User repositories
 *   GET  /users/:did/gpg_keys                       User public GPG keys
 *   GET  /users/:did/social_accounts                User public social accounts
 *   GET  /users/:did/keys                           User public SSH keys
 *   GET  /users/:did/ssh_signing_keys               User public SSH signing keys
 *   GET  /users/:did/gists                          User public gists
 *   GET  /users/:did/orgs                           User public organization memberships
 *   GET  /users/:did/starred                        User's starred repos
 *   GET  /users/:did/subscriptions                  User's watched repos
 *   GET  /users/:did/hovercard                      User hovercard contexts
 *   GET  /users/:did/attestations/:subject_digest   User artifact attestations
 *   GET  /users/:did                                User profile
 *   GET  /users                                     Public users visible to the local actor
 *
 * Write endpoints (POST/PATCH/PUT/DELETE):
 *   POST  /markdown                                  Render Markdown
 *   POST  /markdown/raw                              Render raw Markdown
 *   POST  /gists                                    Create a gist
 *   POST  /gists/:gist_id/comments                 Create a gist comment
 *   POST  /gists/:gist_id/forks                    Fork a gist
 *   PATCH /gists/:gist_id                           Update a gist
 *   PATCH /gists/:gist_id/comments/:comment_id     Update a gist comment
 *   PUT   /gists/:gist_id/star                      Star a gist
 *   DELETE /gists/:gist_id                          Delete a gist
 *   DELETE /gists/:gist_id/comments/:comment_id    Delete a gist comment
 *   DELETE /gists/:gist_id/star                     Unstar a gist
 *   PATCH /user                                      Update authenticated user profile
 *   POST  /users/:did/attestations/bulk-list        List user artifact attestations by digests
 *   DELETE /users/:did/attestations                 Delete user artifact attestations in bulk
 *   DELETE /users/:did/attestations/digest/:subject_digest Delete user artifact attestations by digest
 *   DELETE /users/:did/attestations/:attestation_id Delete user artifact attestation by ID
 *   PATCH /repos/:did/:repo                          Update repository metadata
 *   DELETE /repos/:did/:repo                         Delete repository
 *   POST  /repos/:did/:repo/forks                    Create a fork
 *   POST  /repos/:did/:repo/generate                 Create repository from template
 *   POST  /repos/:did/:repo/transfer                 Request repository transfer
 *   PUT   /repos/:did/:repo/contents/:path            Create or update file contents
 *   DELETE /repos/:did/:repo/contents/:path           Delete file contents
 *   POST  /repos/:did/:repo/git/blobs                 Create git blob object
 *   POST  /repos/:did/:repo/git/trees                 Create git tree object
 *   POST  /repos/:did/:repo/git/commits               Create git commit object
 *   POST  /repos/:did/:repo/git/tags                  Create git tag object
 *   POST  /repos/:did/:repo/git/refs                  Create git reference
 *   PATCH /repos/:did/:repo/git/refs/:ref             Update git reference
 *   DELETE /repos/:did/:repo/git/refs/:ref            Delete git reference
 *   POST  /repos/:did/:repo/commits/:sha/comments     Create commit comment
 *   PATCH /repos/:did/:repo/comments/:id              Update commit comment
 *   DELETE /repos/:did/:repo/comments/:id             Delete commit comment
 *   POST  /repos/:did/:repo/comments/:id/reactions    Create commit comment reaction
 *   DELETE /repos/:did/:repo/comments/:id/reactions/:reaction_id Delete commit comment reaction
 *   POST  /repos/:did/:repo/issues                    Create issue
 *   PATCH /repos/:did/:repo/issues/:number            Update issue
 *   POST  /repos/:did/:repo/issues/:number/comments   Create issue comment
 *   PATCH /repos/:did/:repo/issues/comments/:id       Update issue comment
 *   DELETE /repos/:did/:repo/issues/comments/:id      Delete issue comment
 *   PUT   /repos/:did/:repo/issues/comments/:id/pin   Pin issue comment
 *   DELETE /repos/:did/:repo/issues/comments/:id/pin  Unpin issue comment
 *   POST  /repos/:did/:repo/issues/comments/:id/reactions Create issue comment reaction
 *   DELETE /repos/:did/:repo/issues/comments/:id/reactions/:reaction_id Delete issue comment reaction
 *   POST  /repos/:did/:repo/issues/:number/reactions Create issue reaction
 *   DELETE /repos/:did/:repo/issues/:number/reactions/:reaction_id Delete issue reaction
 *   POST  /repos/:did/:repo/issues/:number/dependencies/blocked_by Add issue dependency
 *   DELETE /repos/:did/:repo/issues/:number/dependencies/blocked_by/:issue_id Remove issue dependency
 *   POST  /repos/:did/:repo/issues/:number/sub_issues Add sub-issue
 *   DELETE /repos/:did/:repo/issues/:number/sub_issue Remove sub-issue
 *   PATCH /repos/:did/:repo/issues/:number/sub_issues/priority Reprioritize sub-issue
 *   POST  /repos/:did/:repo/issues/:number/issue-field-values Add issue field values
 *   PUT   /repos/:did/:repo/issues/:number/issue-field-values Set issue field values
 *   DELETE /repos/:did/:repo/issues/:number/issue-field-values/:issue_field_id Delete issue field value
 *   POST  /repos/:did/:repo/issues/:number/labels     Add issue labels
 *   PUT   /repos/:did/:repo/issues/:number/labels     Replace issue labels
 *   DELETE /repos/:did/:repo/issues/:number/labels    Remove all issue labels
 *   DELETE /repos/:did/:repo/issues/:number/labels/:name Remove issue label
 *   POST  /repos/:did/:repo/labels                    Create repository label
 *   PATCH /repos/:did/:repo/labels/:name              Update repository label
 *   DELETE /repos/:did/:repo/labels/:name             Delete repository label
 *   POST  /repos/:did/:repo/milestones                Create milestone
 *   PATCH /repos/:did/:repo/milestones/:number        Update milestone
 *   DELETE /repos/:did/:repo/milestones/:number       Delete milestone
 *   PUT   /repos/:did/:repo/issues/:number/lock       Lock issue
 *   DELETE /repos/:did/:repo/issues/:number/lock      Unlock issue
 *   POST  /repos/:did/:repo/issues/:number/assignees  Add issue assignees
 *   DELETE /repos/:did/:repo/issues/:number/assignees Remove issue assignees
 *   POST  /repos/:did/:repo/pulls                     Create pull request
 *   PATCH /repos/:did/:repo/pulls/:number             Update pull request
 *   PUT   /repos/:did/:repo/pulls/:number/merge       Merge pull request
 *   PUT   /repos/:did/:repo/pulls/:number/update-branch Update pull request branch
 *   POST  /repos/:did/:repo/pulls/:number/comments    Create pull review comment
 *   POST  /repos/:did/:repo/pulls/:number/requested_reviewers Request pull reviewers
 *   DELETE /repos/:did/:repo/pulls/:number/requested_reviewers Remove pull review requests
 *   PATCH /repos/:did/:repo/pulls/comments/:id        Update pull review comment
 *   DELETE /repos/:did/:repo/pulls/comments/:id       Delete pull review comment
 *   POST  /repos/:did/:repo/pulls/comments/:id/reactions Create pull review comment reaction
 *   DELETE /repos/:did/:repo/pulls/comments/:id/reactions/:reaction_id Delete pull review comment reaction
 *   POST  /repos/:did/:repo/pulls/:number/comments/:id/replies Create pull review comment reply
 *   POST  /repos/:did/:repo/pulls/:number/reviews     Create pull review
 *   PUT/PATCH /repos/:did/:repo/pulls/:number/reviews/:id Update pull review
 *   DELETE /repos/:did/:repo/pulls/:number/reviews/:id Delete pending pull review
 *   PUT   /repos/:did/:repo/pulls/:number/reviews/:id/dismissals Dismiss pull review
 *   POST  /repos/:did/:repo/pulls/:number/reviews/:id/events Submit pull review
 *   POST  /repos/:did/:repo/releases                  Create release
 *   POST  /repos/:did/:repo/releases/generate-notes   Generate release notes
 *   POST  /repos/:did/:repo/releases/:id/assets       Upload release asset
 *   PATCH /repos/:did/:repo/releases/:id              Update release
 *   DELETE /repos/:did/:repo/releases/:id             Delete release
 *   POST  /repos/:did/:repo/releases/:id/reactions    Create release reaction
 *   DELETE /repos/:did/:repo/releases/:id/reactions/:reaction_id Delete release reaction
 *   PATCH /repos/:did/:repo/releases/assets/:id       Update release asset
 *   DELETE /repos/:did/:repo/releases/assets/:id      Delete release asset
 *   PUT   /repos/:did/:repo/environments/:name        Create or update deployment environment
 *   DELETE /repos/:did/:repo/environments/:name       Delete deployment environment
 *   PUT   /repos/:did/:repo/environments/:name/secrets/:secret_name Create/update deployment environment secret
 *   DELETE /repos/:did/:repo/environments/:name/secrets/:secret_name Delete deployment environment secret
 *   POST  /repos/:did/:repo/environments/:name/variables Create deployment environment variable
 *   PATCH /repos/:did/:repo/environments/:name/variables/:variable_name Update deployment environment variable
 *   DELETE /repos/:did/:repo/environments/:name/variables/:variable_name Delete deployment environment variable
 *   POST  /repos/:did/:repo/deployments               Create deployment
 *   DELETE /repos/:did/:repo/deployments/:id          Delete deployment
 *   POST  /repos/:did/:repo/deployments/:id/statuses  Create deployment status
 *   POST  /repos/:did/:repo/pages                     Create GitHub Pages site
 *   PUT   /repos/:did/:repo/pages                     Update GitHub Pages site
 *   DELETE /repos/:did/:repo/pages                    Delete GitHub Pages site
 *   POST  /repos/:did/:repo/pages/builds              Request GitHub Pages build
 *   POST  /repos/:did/:repo/pages/deployments         Create GitHub Pages deployment
 *   POST  /repos/:did/:repo/pages/deployments/:id/cancel Cancel GitHub Pages deployment
 *   POST  /repos/:did/:repo/statuses/:sha             Create commit status
 *   POST  /repos/:did/:repo/check-suites              Create check suite
 *   POST  /repos/:did/:repo/check-suites/:id/rerequest Rerequest check suite
 *   POST  /repos/:did/:repo/check-runs                Create check run
 *   PATCH /repos/:did/:repo/check-runs/:id            Update check run
 *   POST  /repos/:did/:repo/check-runs/:id/rerequest  Rerequest check run
 *   PUT   /repos/:did/:repo/actions/cache/retention-limit Set repository Actions cache retention limit
 *   PUT   /repos/:did/:repo/actions/cache/storage-limit Set repository Actions cache storage limit
 *   DELETE /repos/:did/:repo/actions/caches           Delete repository Actions caches by key
 *   DELETE /repos/:did/:repo/actions/caches/:cache_id Delete repository Actions cache by ID
 *   PUT   /repos/:did/:repo/actions/permissions       Set repository Actions permissions
 *   PUT   /repos/:did/:repo/actions/permissions/selected-actions Set repository allowed Actions settings
 *   PUT   /repos/:did/:repo/actions/permissions/workflow Set repository default workflow permissions
 *   DELETE /repos/:did/:repo/actions/artifacts/:artifact_id Delete artifact
 *   PUT   /repos/:did/:repo/actions/secrets/:name     Create/update repository Actions secret
 *   DELETE /repos/:did/:repo/actions/secrets/:name    Delete repository Actions secret
 *   POST  /repos/:did/:repo/actions/variables         Create repository Actions variable
 *   PATCH /repos/:did/:repo/actions/variables/:name   Update repository Actions variable
 *   DELETE /repos/:did/:repo/actions/variables/:name  Delete repository Actions variable
 *   PUT   /repos/:did/:repo/actions/workflows/:workflow_id/disable Disable workflow
 *   POST  /repos/:did/:repo/actions/workflows/:workflow_id/dispatches Dispatch workflow
 *   PUT   /repos/:did/:repo/actions/workflows/:workflow_id/enable Enable workflow
 *   POST  /repos/:did/:repo/actions/runs/:run_id/rerun Re-run workflow run
 *   POST  /repos/:did/:repo/actions/runs/:run_id/rerun-failed-jobs Re-run failed workflow jobs
 *   POST  /repos/:did/:repo/actions/runs/:run_id/cancel Cancel workflow run
 *   POST  /repos/:did/:repo/actions/runs/:run_id/force-cancel Force cancel workflow run
 *   DELETE /repos/:did/:repo/actions/runs/:run_id     Delete workflow run
 *   DELETE /repos/:did/:repo/actions/runs/:run_id/logs Delete workflow run logs
 *   POST  /repos/:did/:repo/actions/jobs/:job_id/rerun Re-run workflow job
 *   PUT   /repos/:did/:repo/subscription              Set repository subscription
 *   DELETE /repos/:did/:repo/subscription             Delete repository subscription
 *   PUT   /repos/:did/:repo/branches/:branch/protection Update branch protection
 *   DELETE /repos/:did/:repo/branches/:branch/protection Delete branch protection
 *   PATCH /repos/:did/:repo/branches/:branch/protection/required_status_checks Update status check protection
 *   DELETE /repos/:did/:repo/branches/:branch/protection/required_status_checks Delete status check protection
 *   POST  /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Add status check contexts
 *   PUT   /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Set status check contexts
 *   DELETE /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Remove status check contexts
 *   PATCH /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews Update pull request review protection
 *   DELETE /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews Delete pull request review protection
 *   PUT   /repos/:did/:repo/topics                    Replace topics
 *   POST  /repos/:did/:repo/keys                      Create deploy key
 *   DELETE /repos/:did/:repo/keys/:key_id              Delete deploy key
 *   POST  /repos/:did/:repo/autolinks                 Create repository autolink
 *   DELETE /repos/:did/:repo/autolinks/:autolink_id   Delete repository autolink
 *   PUT   /repos/:did/:repo/interaction-limits        Set repository interaction restrictions
 *   DELETE /repos/:did/:repo/interaction-limits       Remove repository interaction restrictions
 *   PATCH /repos/:did/:repo/properties/values         Update repository custom property values
 *   POST  /repos/:did/:repo/dispatches                Create repository dispatch event
 *   POST  /repos/:did/:repo/attestations              Create repository artifact attestation
 *   PUT   /repos/:did/:repo/vulnerability-alerts      Enable vulnerability alerts
 *   DELETE /repos/:did/:repo/vulnerability-alerts     Disable vulnerability alerts
 *   PUT   /repos/:did/:repo/automated-security-fixes  Enable Dependabot security updates
 *   DELETE /repos/:did/:repo/automated-security-fixes Disable Dependabot security updates
 *   PUT   /repos/:did/:repo/immutable-releases        Enable immutable releases
 *   DELETE /repos/:did/:repo/immutable-releases       Disable immutable releases
 *   PUT   /repos/:did/:repo/private-vulnerability-reporting Enable private vulnerability reporting
 *   DELETE /repos/:did/:repo/private-vulnerability-reporting Disable private vulnerability reporting
 *   POST  /repos/:did/:repo/security-advisories      Create repository security advisory
 *   POST  /repos/:did/:repo/security-advisories/reports Privately report security vulnerability
 *   PATCH /repos/:did/:repo/security-advisories/:ghsa_id Update repository security advisory
 *   POST  /repos/:did/:repo/security-advisories/:ghsa_id/cve Request repository advisory CVE
 *   POST  /repos/:did/:repo/security-advisories/:ghsa_id/forks Create temporary private fork
 *   POST  /repos/:did/:repo/secret-scanning/push-protection-bypasses Create secret scanning push protection bypass
 *   PATCH /repos/:did/:repo/code-scanning/alerts/:alert_number Update repository code scanning alert
 *   PATCH /repos/:did/:repo/dependabot/alerts/:alert_number Update repository Dependabot alert
 *   PATCH /repos/:did/:repo/secret-scanning/alerts/:alert_number Update repository secret scanning alert
 *   POST  /repos/:did/:repo/rulesets                  Create repository ruleset
 *   PUT   /repos/:did/:repo/rulesets/:ruleset_id      Update repository ruleset
 *   DELETE /repos/:did/:repo/rulesets/:ruleset_id     Delete repository ruleset
 *   PUT   /repos/:did/:repo/collaborators/:did        Add collaborator
 *   DELETE /repos/:did/:repo/collaborators/:did       Remove collaborator
 *   POST  /repos/:did/:repo/hooks                     Create repository webhook
 *   PATCH /repos/:did/:repo/hooks/:id                 Update repository webhook
 *   DELETE /repos/:did/:repo/hooks/:id                Delete repository webhook
 *   PATCH /repos/:did/:repo/hooks/:id/config          Update repository webhook configuration
 *   POST  /repos/:did/:repo/hooks/:id/deliveries/:delivery_id/attempts Redeliver repository webhook delivery
 *   POST  /repos/:did/:repo/hooks/:id/pings           Ping repository webhook
 *   POST  /repos/:did/:repo/hooks/:id/tests           Test repository webhook
 *   PUT   /notifications                              Mark notifications as read
 *   PATCH /notifications/threads/:id                  Mark notification thread as read
 *   DELETE /notifications/threads/:id                 Mark notification thread as done
 *   PUT   /notifications/threads/:id/subscription     Set notification thread subscription
 *   DELETE /notifications/threads/:id/subscription    Delete notification thread subscription
 *   PATCH /orgs/:org                                  Update organization profile
 *   DELETE /orgs/:org/members/:did                    Remove organization member
 *   PUT   /orgs/:org/memberships/:did                 Set organization membership
 *   DELETE /orgs/:org/memberships/:did                Remove organization membership
 *   DELETE /orgs/:org/invitations/:id                 Cancel organization invitation
 *   PUT   /orgs/:org/blocks/:username                 Block organization user
 *   DELETE /orgs/:org/blocks/:username                Unblock organization user
 *   POST  /orgs/:org/hooks                            Create organization webhook
 *   PATCH /orgs/:org/hooks/:id                        Update organization webhook
 *   DELETE /orgs/:org/hooks/:id                       Delete organization webhook
 *   PATCH /orgs/:org/hooks/:id/config                 Update organization webhook configuration
 *   POST  /orgs/:org/hooks/:id/deliveries/:delivery_id/attempts Redeliver organization webhook delivery
 *   POST  /orgs/:org/hooks/:id/pings                  Ping organization webhook
 *   PATCH /orgs/:org/properties/schema                Create/update organization custom properties
 *   PUT   /orgs/:org/properties/schema/:property      Create/update organization custom property
 *   DELETE /orgs/:org/properties/schema/:property     Delete organization custom property
 *   PATCH /orgs/:org/properties/values                Update organization repository custom property values
 *   POST  /orgs/:org/issue-fields                     Create organization issue field
 *   PATCH /orgs/:org/issue-fields/:issue_field_id      Update organization issue field
 *   DELETE /orgs/:org/issue-fields/:issue_field_id     Delete organization issue field
 *   POST  /orgs/:org/issue-types                      Create organization issue type
 *   PUT   /orgs/:org/issue-types/:issue_type_id        Update organization issue type
 *   DELETE /orgs/:org/issue-types/:issue_type_id       Delete organization issue type
 *   PUT   /orgs/:org/outside_collaborators/:did       Convert member to outside collaborator
 *   DELETE /orgs/:org/outside_collaborators/:did      Remove outside collaborator
 *   PUT   /orgs/:org/public_members/:did              Set public organization membership
 *   DELETE /orgs/:org/public_members/:did             Remove public organization membership
 *   POST  /orgs/:org/repos                            Create organization repository
 *   POST  /orgs/:org/teams                            Create organization team
 *   PATCH /orgs/:org/teams/:team_slug                  Update organization team
 *   DELETE /orgs/:org/teams/:team_slug                 Delete organization team
 *   PUT   /orgs/:org/teams/:team_slug/repos/:did/:repo Add/update team repository permission
 *   DELETE /orgs/:org/teams/:team_slug/repos/:did/:repo Remove team repository permission
 *   PUT   /orgs/:org/teams/:team_slug/memberships/:did Add organization team membership
 *   DELETE /orgs/:org/teams/:team_slug/memberships/:did Remove organization team membership
 *   PATCH /organizations/:org_id/team/:team_id       Update organization team by numeric ID
 *   DELETE /organizations/:org_id/team/:team_id      Delete organization team by numeric ID
 *   PUT   /organizations/:org_id/team/:team_id/memberships/:did Add team membership by numeric ID
 *   DELETE /organizations/:org_id/team/:team_id/memberships/:did Remove team membership by numeric ID
 *   PUT   /organizations/:org_id/team/:team_id/repos/:did/:repo Add/update team repository permission by numeric ID
 *   DELETE /organizations/:org_id/team/:team_id/repos/:did/:repo Remove team repository permission by numeric ID
 *   PATCH /teams/:team_id                            Legacy update organization team by numeric ID
 *   DELETE /teams/:team_id                           Legacy delete organization team by numeric ID
 *   PUT   /teams/:team_id/members/:did               Legacy add organization team membership by numeric ID
 *   DELETE /teams/:team_id/members/:did              Legacy remove organization team membership by numeric ID
 *   PUT   /teams/:team_id/memberships/:did           Legacy add organization team membership by numeric ID
 *   DELETE /teams/:team_id/memberships/:did          Legacy remove organization team membership by numeric ID
 *   PUT   /teams/:team_id/repos/:did/:repo           Legacy add/update team repository permission by numeric ID
 *   DELETE /teams/:team_id/repos/:did/:repo          Legacy remove team repository permission by numeric ID
 *   PUT   /repos/:did/:repo/notifications             Mark repository notifications as read
 *   PATCH /user/memberships/orgs/:org                 Update authenticated organization membership
 *   PATCH /user/email/visibility                      Set primary email visibility
 *   POST  /user/emails                                Add authenticated user's email addresses
 *   DELETE /user/emails                               Delete authenticated user's email addresses
 *   POST  /user/gpg_keys                              Create authenticated user's GPG key
 *   DELETE /user/gpg_keys/:key_id                     Delete authenticated user's GPG key
 *   POST  /user/social_accounts                       Add authenticated user's social accounts
 *   DELETE /user/social_accounts                      Delete authenticated user's social accounts
 *   POST  /user/keys                                  Create authenticated user's SSH key
 *   DELETE /user/keys/:key_id                         Delete authenticated user's SSH key
 *   POST  /user/ssh_signing_keys                      Create authenticated user's SSH signing key
 *   DELETE /user/ssh_signing_keys/:key_id             Delete authenticated user's SSH signing key
 *   POST  /user/repos                                 Create authenticated user's repository
 *   PUT   /user/blocks/:did                           Block a user
 *   DELETE /user/blocks/:did                          Unblock a user
 *   PUT   /user/following/:did                        Follow a user
 *   DELETE /user/following/:did                       Unfollow a user
 *   PUT   /user/starred/:did/:repo                    Star repository
 *   DELETE /user/starred/:did/:repo                   Unstar repository
 *
 * @module
 */

import type { AgentContext } from '../cli/agent.js';
import type { BodyMediaKind } from './body-media.js';
import type { ContentMediaKind } from './contents.js';
import type { GitObjectOptions } from './git-objects.js';
import type { JsonResponse } from './helpers.js';

import type { Server } from 'node:http';

import { createServer } from 'node:http';

import { handleAddAuthenticatedEmails } from './emails.js';
import { handleAddAuthenticatedSocialAccounts } from './social-accounts.js';
import { handleAddOrgTeamMembership } from './orgs.js';
import { handleAddOrgTeamMembershipById } from './orgs.js';
import { handleAddOrUpdateOrgTeamRepo } from './orgs.js';
import { handleAddOrUpdateOrgTeamRepoById } from './orgs.js';
import { handleAddOrUpdateTeamRepoById } from './orgs.js';
import { handleAddTeamMembershipById } from './orgs.js';
import { handleBlockOrgUser } from './orgs.js';
import { handleBlockUser } from './follows.js';
import { handleBulkDeleteUserAttestations } from './user-attestations.js';
import { handleBulkListUserAttestations } from './user-attestations.js';
import { handleCancelOrgInvitation } from './orgs.js';
import { handleCancelPagesDeployment } from './pages.js';
import { handleCancelWorkflowRun } from './actions.js';
import { handleCheckBlockedUser } from './follows.js';
import { handleCheckFollowing } from './follows.js';
import { handleCheckGistStar } from './gists.js';
import { handleCheckOrgBlockedUser } from './orgs.js';
import { handleCheckOrgMember } from './orgs.js';
import { handleCheckOrgTeamMember } from './orgs.js';
import { handleCheckOrgTeamRepo } from './orgs.js';
import { handleCheckOrgTeamRepoById } from './orgs.js';
import { handleCheckPublicOrgMember } from './orgs.js';
import { handleCheckTeamMemberById } from './orgs.js';
import { handleCheckTeamRepoById } from './orgs.js';
import { handleConvertOrgMemberToOutsideCollaborator } from './orgs.js';
import { handleCreateAuthenticatedGpgKey } from './gpg-keys.js';
import { handleCreateAuthenticatedSshKey } from './user-keys.js';
import { handleCreateAuthenticatedSshSigningKey } from './user-keys.js';
import { handleCreateCommitComment } from './commit-comments.js';
import { handleCreateCommitCommentReaction } from './commit-comments.js';
import { handleCreateDeployment } from './deployments.js';
import { handleCreateDeploymentStatus } from './deployments.js';
import { handleCreateEnvironmentVariable } from './actions.js';
import { handleCreateFork } from './repos.js';
import { handleCreateGist } from './gists.js';
import { handleCreateGistComment } from './gists.js';
import { handleCreateOrgIssueField } from './orgs.js';
import { handleCreateOrgIssueType } from './orgs.js';
import { handleCreateOrgRepo } from './orgs.js';
import { handleCreateOrgTeam } from './orgs.js';
import { handleCreateOrUpdateEnvironment } from './deployments.js';
import { handleCreateOrUpdateEnvironmentSecret } from './actions.js';
import { handleCreateOrUpdateRepositorySecret } from './actions.js';
import { handleCreatePagesDeployment } from './pages.js';
import { handleCreatePagesSite } from './pages.js';
import { handleCreateRepositoryVariable } from './actions.js';
import { handleCreateUserRepo } from './repos.js';
import { handleCreateWorkflowDispatch } from './actions.js';
import { handleDeleteActionsCacheById } from './actions.js';
import { handleDeleteActionsCachesByKey } from './actions.js';
import { handleDeleteArtifact } from './actions.js';
import { handleDeleteAuthenticatedEmails } from './emails.js';
import { handleDeleteAuthenticatedGpgKey } from './gpg-keys.js';
import { handleDeleteAuthenticatedSocialAccounts } from './social-accounts.js';
import { handleDeleteAuthenticatedSshKey } from './user-keys.js';
import { handleDeleteAuthenticatedSshSigningKey } from './user-keys.js';
import { handleDeleteCommitComment } from './commit-comments.js';
import { handleDeleteCommitCommentReaction } from './commit-comments.js';
import { handleDeleteDeployment } from './deployments.js';
import { handleDeleteEnvironment } from './deployments.js';
import { handleDeleteEnvironmentSecret } from './actions.js';
import { handleDeleteEnvironmentVariable } from './actions.js';
import { handleDeleteGist } from './gists.js';
import { handleDeleteGistComment } from './gists.js';
import { handleDeleteOrgCustomProperty } from './orgs.js';
import { handleDeleteOrgIssueField } from './orgs.js';
import { handleDeleteOrgIssueType } from './orgs.js';
import { handleDeleteOrgTeam } from './orgs.js';
import { handleDeleteOrgTeamById } from './orgs.js';
import { handleDeletePagesSite } from './pages.js';
import { handleDeleteRepo } from './repos.js';
import { handleDeleteRepositorySecret } from './actions.js';
import { handleDeleteRepositoryVariable } from './actions.js';
import { handleDeleteTeamById } from './orgs.js';
import { handleDeleteUserAttestationById } from './user-attestations.js';
import { handleDeleteUserAttestationsBySubjectDigest } from './user-attestations.js';
import { handleDeleteWorkflowRun } from './actions.js';
import { handleDeleteWorkflowRunLogs } from './actions.js';
import { handleDisableWorkflow } from './actions.js';
import { handleDownloadArtifact } from './actions.js';
import { handleDownloadWorkflowJobLogs } from './actions.js';
import { handleDownloadWorkflowRunAttemptLogs } from './actions.js';
import { handleDownloadWorkflowRunLogs } from './actions.js';
import { handleEnableWorkflow } from './actions.js';
import { handleExportDependencyGraphSbom } from './dependency-graph.js';
import { handleFetchDependencyGraphSbom } from './dependency-graph.js';
import { handleFollowUser } from './follows.js';
import { handleForceCancelWorkflowRun } from './actions.js';
import { handleForkGist } from './gists.js';
import { handleGenerateDependencyGraphSbom } from './dependency-graph.js';
import { handleGenerateRepoFromTemplate } from './repos.js';
import { handleGetActionsCacheRetentionLimit } from './actions.js';
import { handleGetActionsCacheStorageLimit } from './actions.js';
import { handleGetActionsCacheUsage } from './actions.js';
import { handleGetActionsPermissions } from './actions.js';
import { handleGetActionsSelectedActions } from './actions.js';
import { handleGetActionsWorkflowPermissions } from './actions.js';
import { handleGetArtifact } from './actions.js';
import { handleGetAuthenticatedGpgKey } from './gpg-keys.js';
import { handleGetAuthenticatedOrgMembership } from './orgs.js';
import { handleGetAuthenticatedSshKey } from './user-keys.js';
import { handleGetAuthenticatedSshSigningKey } from './user-keys.js';
import { handleGetAuthenticatedUser } from './users.js';
import { handleGetCommitComment } from './commit-comments.js';
import { handleGetCommunityProfile } from './metrics.js';
import { handleGetDeployment } from './deployments.js';
import { handleGetDeploymentStatus } from './deployments.js';
import { handleGetEnvironment } from './deployments.js';
import { handleGetEnvironmentSecret } from './actions.js';
import { handleGetEnvironmentSecretsPublicKey } from './actions.js';
import { handleGetEnvironmentVariable } from './actions.js';
import { handleGetGist } from './gists.js';
import { handleGetGistComment } from './gists.js';
import { handleGetGistRawFile } from './gists.js';
import { handleGetGistRevision } from './gists.js';
import { handleGetLatestPagesBuild } from './pages.js';
import { handleGetOrg } from './orgs.js';
import { handleGetOrgCustomProperty } from './orgs.js';
import { handleGetOrgMembership } from './orgs.js';
import { handleGetOrgTeam } from './orgs.js';
import { handleGetOrgTeamById } from './orgs.js';
import { handleGetOrgTeamMembership } from './orgs.js';
import { handleGetOrgTeamMembershipById } from './orgs.js';
import { handleGetPagesBuild } from './pages.js';
import { handleGetPagesDeploymentStatus } from './pages.js';
import { handleGetPagesHealth } from './pages.js';
import { handleGetPagesSite } from './pages.js';
import { handleGetRepo } from './repos.js';
import { handleGetRepositorySecret } from './actions.js';
import { handleGetRepositorySecretsPublicKey } from './actions.js';
import { handleGetRepositoryVariable } from './actions.js';
import { handleGetStatsCodeFrequency } from './metrics.js';
import { handleGetStatsCommitActivity } from './metrics.js';
import { handleGetStatsContributors } from './metrics.js';
import { handleGetStatsParticipation } from './metrics.js';
import { handleGetStatsPunchCard } from './metrics.js';
import { handleGetTeamById } from './orgs.js';
import { handleGetTeamMembershipById } from './orgs.js';
import { handleGetTrafficClones } from './metrics.js';
import { handleGetTrafficPopularPaths } from './metrics.js';
import { handleGetTrafficPopularReferrers } from './metrics.js';
import { handleGetTrafficViews } from './metrics.js';
import { handleGetUser } from './users.js';
import { handleGetUserById } from './users.js';
import { handleGetUserHovercard } from './users.js';
import { handleGetWorkflow } from './actions.js';
import { handleGetWorkflowJob } from './actions.js';
import { handleGetWorkflowRun } from './actions.js';
import { handleGetWorkflowRunAttempt } from './actions.js';
import { handleGetWorkflowRunUsage } from './actions.js';
import { handleGetWorkflowUsage } from './actions.js';
import { handleListActionsCaches } from './actions.js';
import { handleListArtifacts } from './actions.js';
import { handleListAuthenticatedEmails } from './emails.js';
import { handleListAuthenticatedGists } from './gists.js';
import { handleListAuthenticatedGpgKeys } from './gpg-keys.js';
import { handleListAuthenticatedOrgMemberships } from './orgs.js';
import { handleListAuthenticatedOrgs } from './orgs.js';
import { handleListAuthenticatedPublicEmails } from './emails.js';
import { handleListAuthenticatedRepos } from './repos.js';
import { handleListAuthenticatedSocialAccounts } from './social-accounts.js';
import { handleListAuthenticatedSshKeys } from './user-keys.js';
import { handleListAuthenticatedSshSigningKeys } from './user-keys.js';
import { handleListAuthenticatedUserTeams } from './orgs.js';
import { handleListBlockedUsers } from './follows.js';
import { handleListCommitCommentReactions } from './commit-comments.js';
import { handleListCommitComments } from './commit-comments.js';
import { handleListCommitCommentsForSha } from './commit-comments.js';
import { handleListDeployments } from './deployments.js';
import { handleListDeploymentStatuses } from './deployments.js';
import { handleListEnvironments } from './deployments.js';
import { handleListEnvironmentSecrets } from './actions.js';
import { handleListEnvironmentVariables } from './actions.js';
import { handleListFailedOrgInvitations } from './orgs.js';
import { handleListFollowers } from './follows.js';
import { handleListFollowing } from './follows.js';
import { handleListForks } from './repos.js';
import { handleListGistComments } from './gists.js';
import { handleListGistCommits } from './gists.js';
import { handleListGistForks } from './gists.js';
import { handleListOrganizations } from './orgs.js';
import { handleListOrgBlockedUsers } from './orgs.js';
import { handleListOrgCodeScanningAlerts } from './orgs.js';
import { handleListOrgCustomProperties } from './orgs.js';
import { handleListOrgCustomPropertyValues } from './orgs.js';
import { handleListOrgDependabotAlerts } from './orgs.js';
import { handleListOrgInvitations } from './orgs.js';
import { handleListOrgInvitationTeams } from './orgs.js';
import { handleListOrgIssueFields } from './orgs.js';
import { handleListOrgIssueTypes } from './orgs.js';
import { handleListOrgMembers } from './orgs.js';
import { handleListOrgRepos } from './orgs.js';
import { handleListOrgSecretScanningAlerts } from './orgs.js';
import { handleListOrgSecurityAdvisories } from './orgs.js';
import { handleListOrgTeamChildTeams } from './orgs.js';
import { handleListOrgTeamChildTeamsById } from './orgs.js';
import { handleListOrgTeamInvitations } from './orgs.js';
import { handleListOrgTeamInvitationsById } from './orgs.js';
import { handleListOrgTeamMembers } from './orgs.js';
import { handleListOrgTeamMembersById } from './orgs.js';
import { handleListOrgTeamRepos } from './orgs.js';
import { handleListOrgTeamReposById } from './orgs.js';
import { handleListOrgTeams } from './orgs.js';
import { handleListOutsideCollaborators } from './orgs.js';
import { handleListPagesBuilds } from './pages.js';
import { handleListPublicEvents } from './activity.js';
import { handleListPublicGists } from './gists.js';
import { handleListPublicRepositories } from './repos.js';
import { handleListReceivedEvents } from './activity.js';
import { handleListRepoActivity } from './activity.js';
import { handleListRepoEvents } from './activity.js';
import { handleListRepositorySecrets } from './actions.js';
import { handleListRepositoryVariables } from './actions.js';
import { handleListRepoTeams } from './orgs.js';
import { handleListStarredGists } from './gists.js';
import { handleListTeamChildTeamsById } from './orgs.js';
import { handleListTeamInvitationsById } from './orgs.js';
import { handleListTeamMembersById } from './orgs.js';
import { handleListTeamReposById } from './orgs.js';
import { handleListUserAttestations } from './user-attestations.js';
import { handleListUserEvents } from './activity.js';
import { handleListUserGists } from './gists.js';
import { handleListUserGpgKeys } from './gpg-keys.js';
import { handleListUserOrgs } from './orgs.js';
import { handleListUserRepos } from './repos.js';
import { handleListUsers } from './users.js';
import { handleListUserSocialAccounts } from './social-accounts.js';
import { handleListUserSshKeys } from './user-keys.js';
import { handleListUserSshSigningKeys } from './user-keys.js';
import { handleListWorkflowRunArtifacts } from './actions.js';
import { handleListWorkflowRunJobs } from './actions.js';
import { handleListWorkflowRuns } from './actions.js';
import { handleListWorkflowRunsForWorkflow } from './actions.js';
import { handleListWorkflows } from './actions.js';
import { handlePutOrgCustomProperty } from './orgs.js';
import { handleRemoveOrgMembership } from './orgs.js';
import { handleRemoveOrgTeamMembership } from './orgs.js';
import { handleRemoveOrgTeamMembershipById } from './orgs.js';
import { handleRemoveOrgTeamRepo } from './orgs.js';
import { handleRemoveOrgTeamRepoById } from './orgs.js';
import { handleRemoveOutsideCollaborator } from './orgs.js';
import { handleRemovePublicOrgMembership } from './orgs.js';
import { handleRemoveTeamMembershipById } from './orgs.js';
import { handleRemoveTeamRepoById } from './orgs.js';
import { handleRequestPagesBuild } from './pages.js';
import { handleRerunFailedWorkflowJobs } from './actions.js';
import { handleRerunWorkflowJob } from './actions.js';
import { handleRerunWorkflowRun } from './actions.js';
import { handleSetActionsCacheRetentionLimit } from './actions.js';
import { handleSetActionsCacheStorageLimit } from './actions.js';
import { handleSetActionsPermissions } from './actions.js';
import { handleSetActionsSelectedActions } from './actions.js';
import { handleSetActionsWorkflowPermissions } from './actions.js';
import { handleSetOrgMembership } from './orgs.js';
import { handleSetPrimaryEmailVisibility } from './emails.js';
import { handleSetPublicOrgMembership } from './orgs.js';
import { handleStarGist } from './gists.js';
import { handleTransferRepo } from './repos.js';
import { handleUnblockOrgUser } from './orgs.js';
import { handleUnblockUser } from './follows.js';
import { handleUnfollowUser } from './follows.js';
import { handleUnstarGist } from './gists.js';
import { handleUpdateAuthenticatedOrgMembership } from './orgs.js';
import { handleUpdateAuthenticatedUser } from './users.js';
import { handleUpdateCommitComment } from './commit-comments.js';
import { handleUpdateEnvironmentVariable } from './actions.js';
import { handleUpdateGist } from './gists.js';
import { handleUpdateGistComment } from './gists.js';
import { handleUpdateOrg } from './orgs.js';
import { handleUpdateOrgCustomPropertyValues } from './orgs.js';
import { handleUpdateOrgIssueField } from './orgs.js';
import { handleUpdateOrgIssueType } from './orgs.js';
import { handleUpdateOrgTeam } from './orgs.js';
import { handleUpdateOrgTeamById } from './orgs.js';
import { handleUpdatePagesSite } from './pages.js';
import { handleUpdateRepo } from './repos.js';
import { handleUpdateRepositoryVariable } from './actions.js';
import { handleUpdateTeamById } from './orgs.js';
import { handleUpsertOrgCustomProperties } from './orgs.js';

import { baseHeaders, jsonMethodNotAllowed, jsonNotFound, jsonUnauthorized, validateBearerToken } from './helpers.js';
import {
  handleAddBranchAccessRestrictionActors,
  handleAddStatusCheckContexts,
  handleCreateCommitSignatureProtection,
  handleDeleteAdminBranchProtection,
  handleDeleteBranchAccessRestrictions,
  handleDeleteBranchProtection,
  handleDeleteCommitSignatureProtection,
  handleDeletePullRequestReviewProtection,
  handleDeleteRequiredStatusChecksProtection,
  handleGetAdminBranchProtection,
  handleGetBranch,
  handleGetBranchAccessRestrictions,
  handleGetBranchProtection,
  handleGetCommitSignatureProtection,
  handleGetGitRef,
  handleGetPullRequestReviewProtection,
  handleGetRequiredStatusChecksProtection,
  handleListBranchAccessRestrictionActors,
  handleListBranches,
  handleListMatchingGitRefs,
  handleListStatusCheckContexts,
  handleListTags,
  handleRemoveBranchAccessRestrictionActors,
  handleRemoveStatusCheckContexts,
  handleSetAdminBranchProtection,
  handleSetBranchAccessRestrictionActors,
  handleSetStatusCheckContexts,
  handleUpdateBranchProtection,
  handleUpdatePullRequestReviewProtection,
  handleUpdateRequiredStatusChecksProtection,
} from './git-refs.js';
import {
  handleAddCollaborator,
  handleCheckAssignee,
  handleCheckAutomatedSecurityFixes,
  handleCheckCollaborator,
  handleCheckImmutableReleases,
  handleCheckVulnerabilityAlerts,
  handleCreateAutolink,
  handleCreateDeployKey,
  handleCreateRepositoryAttestation,
  handleCreateRepositoryDispatch,
  handleCreateRepositoryRuleset,
  handleCreateSecretScanningPushProtectionBypass,
  handleCreateSecurityAdvisory,
  handleCreateSecurityAdvisoryPrivateFork,
  handleDeleteAutolink,
  handleDeleteDeployKey,
  handleDeleteInteractionLimit,
  handleDeleteRepositoryRuleset,
  handleDisableAutomatedSecurityFixes,
  handleDisableImmutableReleases,
  handleDisablePrivateVulnerabilityReporting,
  handleDisableVulnerabilityAlerts,
  handleEnableAutomatedSecurityFixes,
  handleEnableImmutableReleases,
  handleEnablePrivateVulnerabilityReporting,
  handleEnableVulnerabilityAlerts,
  handleGetAutolink,
  handleGetCodeScanningAlert,
  handleGetCollaboratorPermission,
  handleGetDependabotAlert,
  handleGetDeployKey,
  handleGetInteractionLimit,
  handleGetLanguages,
  handleGetPrivateVulnerabilityReporting,
  handleGetRepositoryCustomProperties,
  handleGetRepositoryHashAlgorithm,
  handleGetRepositoryRuleset,
  handleGetRepositoryRulesetVersion,
  handleGetRepositoryRuleSuite,
  handleGetRulesForBranch,
  handleGetSecretScanningAlert,
  handleGetSecretScanningScanHistory,
  handleGetSecurityAdvisory,
  handleGetTopics,
  handleListAssignees,
  handleListAutolinks,
  handleListCodeownersErrors,
  handleListCodeScanningAlertInstances,
  handleListCodeScanningAlerts,
  handleListCollaborators,
  handleListDependabotAlerts,
  handleListDeployKeys,
  handleListRepositoryAttestations,
  handleListRepositoryIssueTypes,
  handleListRepositoryRulesetHistory,
  handleListRepositoryRulesets,
  handleListRepositoryRuleSuites,
  handleListSecretScanningAlertLocations,
  handleListSecretScanningAlerts,
  handleListSecurityAdvisories,
  handlePrivatelyReportSecurityVulnerability,
  handleRemoveCollaborator,
  handleReplaceTopics,
  handleRequestSecurityAdvisoryCve,
  handleSetInteractionLimit,
  handleUpdateCodeScanningAlert,
  handleUpdateDependabotAlert,
  handleUpdateRepositoryCustomProperties,
  handleUpdateRepositoryRuleset,
  handleUpdateSecretScanningAlert,
  handleUpdateSecurityAdvisory,
} from './repo-metadata.js';
import {
  handleAddIssueAssignees,
  handleAddIssueDependencyBlockedBy,
  handleAddIssueFieldValues,
  handleAddIssueLabels,
  handleAddIssueSubIssue,
  handleCheckIssueAssignee,
  handleCreateIssue,
  handleCreateIssueComment,
  handleCreateIssueCommentReaction,
  handleCreateIssueReaction,
  handleCreateMilestone,
  handleCreateRepoLabel,
  handleDeleteIssueComment,
  handleDeleteIssueCommentReaction,
  handleDeleteIssueFieldValue,
  handleDeleteIssueReaction,
  handleDeleteMilestone,
  handleDeleteRepoLabel,
  handleGetIssue,
  handleGetIssueComment,
  handleGetIssueEvent,
  handleGetIssueParent,
  handleGetMilestone,
  handleGetRepoLabel,
  handleListAssignedIssues,
  handleListAuthenticatedUserIssues,
  handleListIssueCommentReactions,
  handleListIssueComments,
  handleListIssueDependenciesBlockedBy,
  handleListIssueDependenciesBlocking,
  handleListIssueEvents,
  handleListIssueFieldValues,
  handleListIssueLabels,
  handleListIssueReactions,
  handleListIssues,
  handleListIssueSubIssues,
  handleListIssueTimeline,
  handleListMilestoneLabels,
  handleListMilestones,
  handleListOrgIssues,
  handleListRepoIssueComments,
  handleListRepoIssueEvents,
  handleListRepoLabels,
  handleLockIssue,
  handlePinIssueComment,
  handleRemoveAllIssueLabels,
  handleRemoveIssueAssignees,
  handleRemoveIssueDependencyBlockedBy,
  handleRemoveIssueLabel,
  handleRemoveIssueSubIssue,
  handleReplaceIssueLabels,
  handleReprioritizeIssueSubIssue,
  handleSetIssueFieldValues,
  handleUnlockIssue,
  handleUnpinIssueComment,
  handleUpdateIssue,
  handleUpdateIssueComment,
  handleUpdateMilestone,
  handleUpdateRepoLabel,
} from './issues.js';
import {
  handleCheckPullMerged,
  handleCreatePull,
  handleCreatePullReview,
  handleCreatePullReviewComment,
  handleCreatePullReviewCommentReaction,
  handleCreatePullReviewCommentReply,
  handleDeletePendingPullReview,
  handleDeletePullReviewComment,
  handleDeletePullReviewCommentReaction,
  handleDismissPullReview,
  handleGetPull,
  handleGetPullReview,
  handleGetPullReviewComment,
  handleGetPullText,
  handleListPullCommits,
  handleListPullFiles,
  handleListPullRequestedReviewers,
  handleListPullReviewCommentReactions,
  handleListPullReviewComments,
  handleListPullReviewCommentsForReview,
  handleListPullReviews,
  handleListPulls,
  handleListRepoPullReviewComments,
  handleMergePull,
  handleRemovePullRequestedReviewers,
  handleRequestPullReviewers,
  handleSubmitPullReview,
  handleUpdatePull,
  handleUpdatePullBranch,
  handleUpdatePullReview,
  handleUpdatePullReviewComment,
} from './pulls.js';
import { handleCheckStarredRepo, handleDeleteRepoSubscription, handleGetRepoSubscription, handleListStargazers, handleListStarredRepos, handleListSubscribers, handleListSubscriptions, handleSetRepoSubscription, handleStarRepo, handleUnstarRepo } from './stars.js';
import { handleCompareCommits, handleCompareCommitText, handleCreateGitBlob, handleCreateGitCommit, handleCreateGitRef, handleCreateGitTag, handleCreateGitTree, handleDeleteGitContents, handleDeleteGitRef, handleDownloadArchive, handleGetGitBlob, handleGetGitCommit, handleGetGitTag, handleGetGitTree, handleGetRepoCommit, handleGetRepoCommitMedia, handleListContributors, handleListRepoCommits, handlePutGitContents, handleUpdateGitRef, tryGetGitContents, tryGetGitLicense, tryGetGitRawContent, tryGetGitReadme, tryGetGitReadmeInDirectory } from './git-objects.js';
import { handleCreateCheckRun, handleCreateCheckSuite, handleCreateCommitStatus, handleGetCheckRun, handleGetCheckSuite, handleGetCombinedStatus, handleListCheckRunAnnotations, handleListCheckRunsForRef, handleListCheckRunsForSuite, handleListCheckSuitesForRef, handleListCommitStatuses, handleRerequestCheckRun, handleRerequestCheckSuite, handleUpdateCheckRun } from './checks.js';
import {
  handleCreateOrgWebhook,
  handleCreateRepoWebhook,
  handleDeleteOrgWebhook,
  handleDeleteRepoWebhook,
  handleGetOrgWebhook,
  handleGetOrgWebhookConfig,
  handleGetOrgWebhookDelivery,
  handleGetRepoWebhook,
  handleGetRepoWebhookConfig,
  handleGetRepoWebhookDelivery,
  handleListOrgWebhookDeliveries,
  handleListOrgWebhooks,
  handleListRepoWebhookDeliveries,
  handleListRepoWebhooks,
  handlePingOrgWebhook,
  handlePingRepoWebhook,
  handleRedeliverOrgWebhookDelivery,
  handleRedeliverRepoWebhookDelivery,
  handleTestRepoWebhook,
  handleUpdateOrgWebhook,
  handleUpdateOrgWebhookConfig,
  handleUpdateRepoWebhook,
  handleUpdateRepoWebhookConfig,
} from './webhooks.js';
import { handleCreateRelease, handleCreateReleaseReaction, handleDeleteRelease, handleDeleteReleaseAsset, handleDeleteReleaseReaction, handleDownloadReleaseAsset, handleDownloadReleaseAssetByName, handleGenerateReleaseNotes, handleGetLatestRelease, handleGetReleaseAsset, handleGetReleaseById, handleGetReleaseByTag, handleListReleaseAssets, handleListReleaseReactions, handleListReleases, handleUpdateRelease, handleUpdateReleaseAsset, handleUploadReleaseAsset } from './releases.js';
import { handleDeleteNotificationThread, handleDeleteNotificationThreadSubscription, handleGetNotificationThread, handleGetNotificationThreadSubscription, handleListNotifications, handleListRepoNotifications, handleMarkNotificationsRead, handleMarkNotificationThreadRead, handleMarkRepoNotificationsRead, handleSetNotificationThreadSubscription } from './notifications.js';
import { handleGetApiVersions, handleGetEmojis, handleGetGitignoreTemplate, handleGetLicense as handleGetLicenseTemplate, handleGetMeta, handleGetRateLimit, handleGetZen, handleGitHubApiRoot, handleListGitignoreTemplates, handleListLicenses, handleRenderMarkdown, handleRenderRawMarkdown } from './meta.js';
import { handleGetContents, handleGetLicense, handleGetRawContent, handleGetReadme, handleGetReadmeInDirectory } from './contents.js';
import { handleSearchCode, handleSearchCommits, handleSearchIssues, handleSearchLabels, handleSearchRepositories, handleSearchTopics, handleSearchUsers } from './search.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShimServerOptions = {
  ctx : AgentContext;
  port : number;
  reposPath? : string;
};

export type ShimRequestOptions = GitObjectOptions & {
  rawBody? : Uint8Array;
  contentType? : string;
  accept? : string;
};

// ---------------------------------------------------------------------------
// Supported HTTP methods
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);

/** Maximum JSON request body size (1 MB). */
const MAX_JSON_BODY = 1 * 1024 * 1024;

/** Maximum buffered binary request body size for release asset uploads (100 MB). */
const MAX_BINARY_BODY = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// DID extraction regex
// ---------------------------------------------------------------------------

/**
 * DID methods use the pattern `did:<method>:<id>`.  We capture the full
 * DID and the remaining path segments.
 */
const REPOS_RE = /^\/repos\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([^/]+)(\/.*)?$/;
const NETWORKS_EVENTS_RE = /^\/networks\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([^/]+)\/events$/;
const GISTS_RE = /^\/gists\/([^/]+)$/;
const GISTS_COMMITS_RE = /^\/gists\/([^/]+)\/commits$/;
const GISTS_COMMENTS_RE = /^\/gists\/([^/]+)\/comments$/;
const GISTS_COMMENT_RE = /^\/gists\/([^/]+)\/comments\/(\d+)$/;
const GISTS_FORKS_RE = /^\/gists\/([^/]+)\/forks$/;
const GISTS_RAW_RE = /^\/gists\/([^/]+)\/raw\/(.+)$/;
const GISTS_REVISION_RE = /^\/gists\/([^/]+)\/([0-9a-f]{7,40})$/i;
const GISTS_STAR_RE = /^\/gists\/([^/]+)\/star$/;
const USERS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/;
const USERS_ATTESTATIONS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/attestations$/;
const USERS_ATTESTATIONS_BULK_LIST_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/attestations\/bulk-list$/;
const USERS_ATTESTATIONS_DIGEST_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/attestations\/digest\/(.+)$/;
const USERS_ATTESTATION_ID_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/attestations\/(\d+)$/;
const USERS_ATTESTATIONS_SUBJECT_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/attestations\/(.+)$/;
const USERS_EVENTS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/events$/;
const USERS_EVENTS_PUBLIC_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/events\/public$/;
const USERS_FOLLOWERS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/followers$/;
const USERS_FOLLOWING_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/following$/;
const USERS_FOLLOWING_TARGET_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/following\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/;
const USERS_GISTS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/gists$/;
const USERS_GPG_KEYS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/gpg_keys$/;
const USERS_HOVERCARD_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/hovercard$/;
const USERS_KEYS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/keys$/;
const USERS_ORGS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/orgs$/;
const USERS_RECEIVED_EVENTS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/received_events$/;
const USERS_RECEIVED_EVENTS_PUBLIC_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/received_events\/public$/;
const USERS_SOCIAL_ACCOUNTS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/social_accounts$/;
const USERS_SSH_SIGNING_KEYS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/ssh_signing_keys$/;
const USERS_STARRED_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/starred$/;
const USERS_SUBSCRIPTIONS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/subscriptions$/;

const RELEASE_ASSET_UPLOAD_RE = /^\/repos\/did:[a-z0-9]+:[a-zA-Z0-9._:%-]+\/[^/]+\/releases\/\d+\/assets$/;
const MARKDOWN_RAW_RE = /^\/markdown\/raw$/;

function githubTextMediaKind(accept: string | undefined): 'diff' | 'patch' | null {
  const parts = (accept ?? '').split(',').map(part => part.trim().toLowerCase());
  for (const part of parts) {
    const media = part.split(';')[0]?.trim();
    if (media === 'application/vnd.github.diff' || media === 'application/vnd.github.v3.diff') {
      return 'diff';
    }
    if (media === 'application/vnd.github.patch' || media === 'application/vnd.github.v3.patch') {
      return 'patch';
    }
  }
  return null;
}

function githubCommitMediaKind(accept: string | undefined): 'diff' | 'patch' | 'sha' | null {
  const textKind = githubTextMediaKind(accept);
  if (textKind) {
    return textKind;
  }
  const parts = (accept ?? '').split(',').map(part => part.trim().toLowerCase());
  for (const part of parts) {
    const media = part.split(';')[0]?.trim();
    if (media === 'application/vnd.github.sha' || media === 'application/vnd.github.v3.sha') {
      return 'sha';
    }
  }
  return null;
}

function githubContentMediaKind(accept: string | undefined): ContentMediaKind | null {
  const parts = (accept ?? '').split(',').map(part => part.trim().toLowerCase());
  for (const part of parts) {
    const media = part.split(';')[0]?.trim();
    if (!media) {
      continue;
    }
    const normalized = media.endsWith('+json') ? media.slice(0, -5) : media;
    if (normalized === 'application/vnd.github.raw' || normalized === 'application/vnd.github.v3.raw') {
      return 'raw';
    }
    if (normalized === 'application/vnd.github.html' || normalized === 'application/vnd.github.v3.html') {
      return 'html';
    }
    if (normalized === 'application/vnd.github.object' || normalized === 'application/vnd.github.v3.object') {
      return 'object';
    }
  }
  return null;
}

function githubReadmeMediaKind(accept: string | undefined): ContentMediaKind | null {
  const mediaKind = githubContentMediaKind(accept);
  return mediaKind === 'raw' || mediaKind === 'html' ? mediaKind : null;
}

function githubLicenseMediaKind(accept: string | undefined): ContentMediaKind | null {
  return githubReadmeMediaKind(accept);
}

function githubBlobMediaKind(accept: string | undefined): 'raw' | null {
  return githubContentMediaKind(accept) === 'raw' ? 'raw' : null;
}

function githubReleaseAssetMediaKind(accept: string | undefined): 'binary' | null {
  const parts = (accept ?? '').split(',').map(part => part.trim().toLowerCase());
  for (const part of parts) {
    const media = part.split(';')[0]?.trim();
    if (media === 'application/octet-stream') {
      return 'binary';
    }
  }
  return null;
}

function githubBodyMediaKindFor(accept: string | undefined, vendorSubtype: string): BodyMediaKind | null {
  const parts = (accept ?? '').split(',').map(part => part.trim().toLowerCase());
  for (const part of parts) {
    const media = part.split(';')[0]?.trim();
    if (!media) {
      continue;
    }
    const normalized = media.endsWith('+json') ? media.slice(0, -5) : media;
    if (normalized === `application/vnd.${vendorSubtype}.raw`
      || normalized === `application/vnd.${vendorSubtype}.v3.raw`) {
      return 'raw';
    }
    if (normalized === `application/vnd.${vendorSubtype}.text`
      || normalized === `application/vnd.${vendorSubtype}.v3.text`) {
      return 'text';
    }
    if (normalized === `application/vnd.${vendorSubtype}.html`
      || normalized === `application/vnd.${vendorSubtype}.v3.html`) {
      return 'html';
    }
    if (normalized === `application/vnd.${vendorSubtype}.full`
      || normalized === `application/vnd.${vendorSubtype}.v3.full`) {
      return 'full';
    }
  }
  return null;
}

function githubBodyMediaKind(accept: string | undefined): BodyMediaKind | null {
  return githubBodyMediaKindFor(accept, 'github');
}

function githubCommitCommentBodyMediaKind(accept: string | undefined): BodyMediaKind | null {
  return githubBodyMediaKindFor(accept, 'github-commitcomment');
}

const USER_ACCOUNT_RE = /^\/user\/(\d+)$/;
const USER_BLOCK_RE = /^\/user\/blocks\/([^/]+)$/;
const USER_FOLLOWING_RE = /^\/user\/following\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/;
const USER_GPG_KEY_RE = /^\/user\/gpg_keys\/(\d+)$/;
const USER_KEY_RE = /^\/user\/keys\/(\d+)$/;
const USER_MEMBERSHIP_ORG_RE = /^\/user\/memberships\/orgs\/([^/]+)$/;
const USER_SSH_SIGNING_KEY_RE = /^\/user\/ssh_signing_keys\/(\d+)$/;
const USER_STARRED_RE = /^\/user\/starred\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([^/]+)$/;
const ORGS_RE = /^\/orgs\/([^/]+)$/;
const ORGS_MEMBERS_RE = /^\/orgs\/([^/]+)\/members$/;
const ORGS_MEMBER_RE = /^\/orgs\/([^/]+)\/members\/([^/]+)$/;
const ORGS_MEMBERSHIP_RE = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/;
const ORGS_FAILED_INVITATIONS_RE = /^\/orgs\/([^/]+)\/failed_invitations$/;
const ORGS_INVITATIONS_RE = /^\/orgs\/([^/]+)\/invitations$/;
const ORGS_INVITATION_RE = /^\/orgs\/([^/]+)\/invitations\/(\d+)$/;
const ORGS_INVITATION_TEAMS_RE = /^\/orgs\/([^/]+)\/invitations\/(\d+)\/teams$/;
const ORGS_BLOCKS_RE = /^\/orgs\/([^/]+)\/blocks$/;
const ORGS_BLOCK_RE = /^\/orgs\/([^/]+)\/blocks\/([^/]+)$/;
const ORGS_HOOKS_RE = /^\/orgs\/([^/]+)\/hooks$/;
const ORGS_HOOK_RE = /^\/orgs\/([^/]+)\/hooks\/(\d+)$/;
const ORGS_HOOK_CONFIG_RE = /^\/orgs\/([^/]+)\/hooks\/(\d+)\/config$/;
const ORGS_HOOK_DELIVERIES_RE = /^\/orgs\/([^/]+)\/hooks\/(\d+)\/deliveries$/;
const ORGS_HOOK_DELIVERY_RE = /^\/orgs\/([^/]+)\/hooks\/(\d+)\/deliveries\/(\d+)$/;
const ORGS_HOOK_DELIVERY_ATTEMPTS_RE = /^\/orgs\/([^/]+)\/hooks\/(\d+)\/deliveries\/(\d+)\/attempts$/;
const ORGS_HOOK_PING_RE = /^\/orgs\/([^/]+)\/hooks\/(\d+)\/pings$/;
const ORGS_CUSTOM_PROPERTIES_SCHEMA_RE = /^\/orgs\/([^/]+)\/properties\/schema$/;
const ORGS_CUSTOM_PROPERTY_SCHEMA_RE = /^\/orgs\/([^/]+)\/properties\/schema\/([^/]+)$/;
const ORGS_CUSTOM_PROPERTY_VALUES_RE = /^\/orgs\/([^/]+)\/properties\/values$/;
const ORGS_ISSUE_FIELDS_RE = /^\/orgs\/([^/]+)\/issue-fields$/;
const ORGS_ISSUE_FIELD_RE = /^\/orgs\/([^/]+)\/issue-fields\/(\d+)$/;
const ORGS_ISSUE_TYPES_RE = /^\/orgs\/([^/]+)\/issue-types$/;
const ORGS_ISSUE_TYPE_RE = /^\/orgs\/([^/]+)\/issue-types\/(\d+)$/;
const ORGS_OUTSIDE_COLLABORATORS_RE = /^\/orgs\/([^/]+)\/outside_collaborators$/;
const ORGS_OUTSIDE_COLLABORATOR_RE = /^\/orgs\/([^/]+)\/outside_collaborators\/([^/]+)$/;
const ORGS_PUBLIC_MEMBERS_RE = /^\/orgs\/([^/]+)\/public_members$/;
const ORGS_PUBLIC_MEMBER_RE = /^\/orgs\/([^/]+)\/public_members\/([^/]+)$/;
const ORGS_ISSUES_RE = /^\/orgs\/([^/]+)\/issues$/;
const ORGS_REPOS_RE = /^\/orgs\/([^/]+)\/repos$/;
const ORGS_CODE_SCANNING_ALERTS_RE = /^\/orgs\/([^/]+)\/code-scanning\/alerts$/;
const ORGS_DEPENDABOT_ALERTS_RE = /^\/orgs\/([^/]+)\/dependabot\/alerts$/;
const ORGS_SECRET_SCANNING_ALERTS_RE = /^\/orgs\/([^/]+)\/secret-scanning\/alerts$/;
const ORGS_SECURITY_ADVISORIES_RE = /^\/orgs\/([^/]+)\/security-advisories$/;
const ORGS_TEAMS_RE = /^\/orgs\/([^/]+)\/teams$/;
const ORGS_TEAM_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)$/;
const ORGS_TEAM_CHILD_TEAMS_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/teams$/;
const ORGS_TEAM_INVITATIONS_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/invitations$/;
const ORGS_TEAM_MEMBERS_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/members$/;
const ORGS_TEAM_MEMBER_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/;
const ORGS_TEAM_MEMBERSHIP_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/([^/]+)$/;
const ORGS_TEAM_REPOS_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/repos$/;
const ORGS_TEAM_REPO_RE = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/repos\/([^/]+)\/([^/]+)$/;
const ORGANIZATIONS_TEAM_RE = /^\/organizations\/(\d+)\/team\/(\d+)$/;
const ORGANIZATIONS_TEAM_CHILD_TEAMS_RE = /^\/organizations\/(\d+)\/team\/(\d+)\/teams$/;
const ORGANIZATIONS_TEAM_INVITATIONS_RE = /^\/organizations\/(\d+)\/team\/(\d+)\/invitations$/;
const ORGANIZATIONS_TEAM_MEMBERS_RE = /^\/organizations\/(\d+)\/team\/(\d+)\/members$/;
const ORGANIZATIONS_TEAM_MEMBERSHIP_RE = /^\/organizations\/(\d+)\/team\/(\d+)\/memberships\/([^/]+)$/;
const ORGANIZATIONS_TEAM_REPOS_RE = /^\/organizations\/(\d+)\/team\/(\d+)\/repos$/;
const ORGANIZATIONS_TEAM_REPO_RE = /^\/organizations\/(\d+)\/team\/(\d+)\/repos\/([^/]+)\/([^/]+)$/;
const TEAMS_RE = /^\/teams\/(\d+)$/;
const TEAMS_CHILD_TEAMS_RE = /^\/teams\/(\d+)\/teams$/;
const TEAMS_INVITATIONS_RE = /^\/teams\/(\d+)\/invitations$/;
const TEAMS_MEMBERS_RE = /^\/teams\/(\d+)\/members$/;
const TEAMS_MEMBER_RE = /^\/teams\/(\d+)\/members\/([^/]+)$/;
const TEAMS_MEMBERSHIP_RE = /^\/teams\/(\d+)\/memberships\/([^/]+)$/;
const TEAMS_REPOS_RE = /^\/teams\/(\d+)\/repos$/;
const TEAMS_REPO_RE = /^\/teams\/(\d+)\/repos\/([^/]+)\/([^/]+)$/;
const USERS_REPOS_RE = /^\/users\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/repos$/;
const NOTIFICATION_THREAD_RE = /^\/notifications\/threads\/(\d+)$/;
const NOTIFICATION_THREAD_SUBSCRIPTION_RE = /^\/notifications\/threads\/(\d+)\/subscription$/;

function requiresWriteAuth(method: string, path: string): boolean {
  if (method !== 'POST' && method !== 'PATCH' && method !== 'PUT' && method !== 'DELETE') {
    return false;
  }

  return path !== '/markdown' && path !== '/markdown/raw';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route an incoming request to the appropriate handler.
 *
 * This function is exported for testing — tests can call it directly
 * with a constructed URL without starting an HTTP server.
 *
 * @param method  HTTP method (defaults to `'GET'` for backward compat).
 * @param reqBody Parsed JSON body for POST/PATCH/PUT requests.
 * @param authHeader The Authorization header value (for write endpoint auth).
 */
export async function handleShimRequest(
  ctx: AgentContext,
  url: URL,
  method: string = 'GET',
  reqBody: Record<string, unknown> = {},
  authHeader: string | null = null,
  options: ShimRequestOptions = {},
): Promise<JsonResponse> {
  const path = url.pathname;

  // Authenticate mutating requests when GITD_API_TOKEN is configured.
  if (requiresWriteAuth(method, path)) {
    if (!validateBearerToken(authHeader)) {
      return jsonUnauthorized('Valid Bearer token required for write operations.');
    }
  }

  // -------------------------------------------------------------------------
  // Global GitHub utility endpoints
  // -------------------------------------------------------------------------
  if (path === '/') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /.`); }
    return handleGitHubApiRoot(url);
  }

  if (path === '/meta') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /meta.`); }
    return handleGetMeta(url);
  }

  if (path === '/versions') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /versions.`); }
    return handleGetApiVersions();
  }

  if (path === '/zen') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /zen.`); }
    return handleGetZen();
  }

  if (path === '/rate_limit') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /rate_limit.`); }
    return handleGetRateLimit();
  }

  if (path === '/emojis') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /emojis.`); }
    return handleGetEmojis();
  }

  if (path === '/gitignore/templates') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /gitignore/templates.`); }
    return handleListGitignoreTemplates();
  }

  const gitignoreTemplateMatch = path.match(/^\/gitignore\/templates\/([^/]+)$/);
  if (gitignoreTemplateMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /gitignore/templates/:name.`); }
    return handleGetGitignoreTemplate(gitignoreTemplateMatch[1]);
  }

  if (path === '/licenses') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /licenses.`); }
    return handleListLicenses(url);
  }

  const licenseMatch = path.match(/^\/licenses\/([^/]+)$/);
  if (licenseMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /licenses/:license.`); }
    return handleGetLicenseTemplate(licenseMatch[1], url);
  }

  if (path === '/events') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /events.`); }
    return handleListPublicEvents(ctx, url);
  }

  if (path === '/repositories') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} is not allowed on /repositories.`); }
    return handleListPublicRepositories(ctx, url);
  }

  const networkEventsMatch = path.match(NETWORKS_EVENTS_RE);
  if (networkEventsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /networks/:owner/:repo/events.`);
    }
    return handleListRepoEvents(ctx, networkEventsMatch[1], networkEventsMatch[2], url, 'networks');
  }

  if (path === '/markdown') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} is not allowed on /markdown.`); }
    return handleRenderMarkdown(reqBody);
  }

  if (path === '/markdown/raw') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} is not allowed on /markdown/raw.`); }
    return handleRenderRawMarkdown(options);
  }

  // -------------------------------------------------------------------------
  // /notifications and /notifications/threads/:thread_id
  // -------------------------------------------------------------------------
  if (path === '/notifications') {
    if (method === 'GET') { return handleListNotifications(ctx, url); }
    if (method === 'PUT') { return handleMarkNotificationsRead(ctx, reqBody); }
    return jsonMethodNotAllowed(`${method} is not allowed on /notifications.`);
  }

  if (path === '/issues') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /issues.`);
    }
    return handleListAssignedIssues(ctx, url, githubBodyMediaKind(options.accept));
  }

  const notificationThreadSubscriptionMatch = path.match(NOTIFICATION_THREAD_SUBSCRIPTION_RE);
  if (notificationThreadSubscriptionMatch) {
    if (method === 'GET') { return handleGetNotificationThreadSubscription(ctx, notificationThreadSubscriptionMatch[1], url); }
    if (method === 'PUT') { return handleSetNotificationThreadSubscription(ctx, notificationThreadSubscriptionMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteNotificationThreadSubscription(ctx, notificationThreadSubscriptionMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /notifications/threads/:thread_id/subscription.`);
  }

  const notificationThreadMatch = path.match(NOTIFICATION_THREAD_RE);
  if (notificationThreadMatch) {
    if (method === 'GET') { return handleGetNotificationThread(ctx, notificationThreadMatch[1], url); }
    if (method === 'PATCH') { return handleMarkNotificationThreadRead(ctx, notificationThreadMatch[1]); }
    if (method === 'DELETE') { return handleDeleteNotificationThread(ctx, notificationThreadMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /notifications/threads/:thread_id.`);
  }

  if (path === '/organizations') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /organizations.`);
    }
    return handleListOrganizations(ctx, url);
  }

  if (path === '/search/repositories') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /search/repositories.`);
    }
    return handleSearchRepositories(ctx, url);
  }

  if (path === '/search/code') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /search/code.`);
    }
    return handleSearchCode(ctx, url, options);
  }

  if (path === '/search/commits') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /search/commits.`);
    }
    return handleSearchCommits(ctx, url, options);
  }

  if (path === '/search/issues') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /search/issues.`);
    }
    return handleSearchIssues(ctx, url);
  }

  if (path === '/search/labels') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /search/labels.`);
    }
    return handleSearchLabels(ctx, url);
  }

  if (path === '/search/topics') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /search/topics.`);
    }
    return handleSearchTopics(ctx, url);
  }

  if (path === '/search/users') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /search/users.`);
    }
    return handleSearchUsers(ctx, url);
  }

  const organizationTeamRepoMatch = path.match(ORGANIZATIONS_TEAM_REPO_RE);
  if (organizationTeamRepoMatch) {
    if (method === 'GET') {
      return handleCheckOrgTeamRepoById(
        ctx,
        organizationTeamRepoMatch[1],
        organizationTeamRepoMatch[2],
        organizationTeamRepoMatch[3],
        organizationTeamRepoMatch[4],
        url,
      );
    }
    if (method === 'PUT') {
      return handleAddOrUpdateOrgTeamRepoById(
        ctx,
        organizationTeamRepoMatch[1],
        organizationTeamRepoMatch[2],
        organizationTeamRepoMatch[3],
        organizationTeamRepoMatch[4],
        reqBody,
      );
    }
    if (method === 'DELETE') {
      return handleRemoveOrgTeamRepoById(
        ctx,
        organizationTeamRepoMatch[1],
        organizationTeamRepoMatch[2],
        organizationTeamRepoMatch[3],
        organizationTeamRepoMatch[4],
      );
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /organizations/:org_id/team/:team_id/repos/:owner/:repo.`);
  }

  const organizationTeamReposMatch = path.match(ORGANIZATIONS_TEAM_REPOS_RE);
  if (organizationTeamReposMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /organizations/:org_id/team/:team_id/repos.`);
    }
    return handleListOrgTeamReposById(ctx, organizationTeamReposMatch[1], organizationTeamReposMatch[2], url);
  }

  const organizationTeamInvitationsMatch = path.match(ORGANIZATIONS_TEAM_INVITATIONS_RE);
  if (organizationTeamInvitationsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /organizations/:org_id/team/:team_id/invitations.`);
    }
    return handleListOrgTeamInvitationsById(ctx, organizationTeamInvitationsMatch[1], organizationTeamInvitationsMatch[2], url);
  }

  const organizationTeamMembershipMatch = path.match(ORGANIZATIONS_TEAM_MEMBERSHIP_RE);
  if (organizationTeamMembershipMatch) {
    if (method === 'GET') {
      return handleGetOrgTeamMembershipById(
        ctx,
        organizationTeamMembershipMatch[1],
        organizationTeamMembershipMatch[2],
        organizationTeamMembershipMatch[3],
        url,
      );
    }
    if (method === 'PUT') {
      return handleAddOrgTeamMembershipById(
        ctx,
        organizationTeamMembershipMatch[1],
        organizationTeamMembershipMatch[2],
        organizationTeamMembershipMatch[3],
        reqBody,
        url,
      );
    }
    if (method === 'DELETE') {
      return handleRemoveOrgTeamMembershipById(
        ctx,
        organizationTeamMembershipMatch[1],
        organizationTeamMembershipMatch[2],
        organizationTeamMembershipMatch[3],
      );
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /organizations/:org_id/team/:team_id/memberships/:username.`);
  }

  const organizationTeamMembersMatch = path.match(ORGANIZATIONS_TEAM_MEMBERS_RE);
  if (organizationTeamMembersMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /organizations/:org_id/team/:team_id/members.`);
    }
    return handleListOrgTeamMembersById(ctx, organizationTeamMembersMatch[1], organizationTeamMembersMatch[2], url);
  }

  const organizationTeamChildTeamsMatch = path.match(ORGANIZATIONS_TEAM_CHILD_TEAMS_RE);
  if (organizationTeamChildTeamsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /organizations/:org_id/team/:team_id/teams.`);
    }
    return handleListOrgTeamChildTeamsById(ctx, organizationTeamChildTeamsMatch[1], organizationTeamChildTeamsMatch[2], url);
  }

  const organizationTeamMatch = path.match(ORGANIZATIONS_TEAM_RE);
  if (organizationTeamMatch) {
    if (method === 'GET') {
      return handleGetOrgTeamById(ctx, organizationTeamMatch[1], organizationTeamMatch[2], url);
    }
    if (method === 'PATCH') {
      return handleUpdateOrgTeamById(ctx, organizationTeamMatch[1], organizationTeamMatch[2], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleDeleteOrgTeamById(ctx, organizationTeamMatch[1], organizationTeamMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /organizations/:org_id/team/:team_id.`);
  }

  const teamRepoMatch = path.match(TEAMS_REPO_RE);
  if (teamRepoMatch) {
    if (method === 'GET') {
      return handleCheckTeamRepoById(ctx, teamRepoMatch[1], teamRepoMatch[2], teamRepoMatch[3], url);
    }
    if (method === 'PUT') {
      return handleAddOrUpdateTeamRepoById(ctx, teamRepoMatch[1], teamRepoMatch[2], teamRepoMatch[3], reqBody);
    }
    if (method === 'DELETE') {
      return handleRemoveTeamRepoById(ctx, teamRepoMatch[1], teamRepoMatch[2], teamRepoMatch[3]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id/repos/:owner/:repo.`);
  }

  const teamReposMatch = path.match(TEAMS_REPOS_RE);
  if (teamReposMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id/repos.`);
    }
    return handleListTeamReposById(ctx, teamReposMatch[1], url);
  }

  const teamInvitationsMatch = path.match(TEAMS_INVITATIONS_RE);
  if (teamInvitationsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id/invitations.`);
    }
    return handleListTeamInvitationsById(ctx, teamInvitationsMatch[1], url);
  }

  const teamMembershipMatch = path.match(TEAMS_MEMBERSHIP_RE);
  if (teamMembershipMatch) {
    if (method === 'GET') {
      return handleGetTeamMembershipById(ctx, teamMembershipMatch[1], teamMembershipMatch[2], url);
    }
    if (method === 'PUT') {
      return handleAddTeamMembershipById(ctx, teamMembershipMatch[1], teamMembershipMatch[2], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleRemoveTeamMembershipById(ctx, teamMembershipMatch[1], teamMembershipMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id/memberships/:username.`);
  }

  const teamMemberMatch = path.match(TEAMS_MEMBER_RE);
  if (teamMemberMatch) {
    if (method === 'GET') {
      return handleCheckTeamMemberById(ctx, teamMemberMatch[1], teamMemberMatch[2]);
    }
    if (method === 'PUT') {
      return handleAddTeamMembershipById(ctx, teamMemberMatch[1], teamMemberMatch[2], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleRemoveTeamMembershipById(ctx, teamMemberMatch[1], teamMemberMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id/members/:username.`);
  }

  const teamMembersMatch = path.match(TEAMS_MEMBERS_RE);
  if (teamMembersMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id/members.`);
    }
    return handleListTeamMembersById(ctx, teamMembersMatch[1], url);
  }

  const teamChildTeamsMatch = path.match(TEAMS_CHILD_TEAMS_RE);
  if (teamChildTeamsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id/teams.`);
    }
    return handleListTeamChildTeamsById(ctx, teamChildTeamsMatch[1], url);
  }

  const teamMatch = path.match(TEAMS_RE);
  if (teamMatch) {
    if (method === 'GET') {
      return handleGetTeamById(ctx, teamMatch[1], url);
    }
    if (method === 'PATCH') {
      return handleUpdateTeamById(ctx, teamMatch[1], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleDeleteTeamById(ctx, teamMatch[1]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /teams/:team_id.`);
  }

  // -------------------------------------------------------------------------
  // /orgs/:org, /orgs/:org/members, and /orgs/:org/teams
  // -------------------------------------------------------------------------
  const orgTeamRepoMatch = path.match(ORGS_TEAM_REPO_RE);
  if (orgTeamRepoMatch) {
    if (method === 'GET') {
      return handleCheckOrgTeamRepo(ctx, orgTeamRepoMatch[1], orgTeamRepoMatch[2], orgTeamRepoMatch[3], orgTeamRepoMatch[4], url);
    }
    if (method === 'PUT') {
      return handleAddOrUpdateOrgTeamRepo(ctx, orgTeamRepoMatch[1], orgTeamRepoMatch[2], orgTeamRepoMatch[3], orgTeamRepoMatch[4], reqBody);
    }
    if (method === 'DELETE') {
      return handleRemoveOrgTeamRepo(ctx, orgTeamRepoMatch[1], orgTeamRepoMatch[2], orgTeamRepoMatch[3], orgTeamRepoMatch[4]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug/repos/:owner/:repo.`);
  }

  const orgTeamReposMatch = path.match(ORGS_TEAM_REPOS_RE);
  if (orgTeamReposMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug/repos.`);
    }
    return handleListOrgTeamRepos(ctx, orgTeamReposMatch[1], orgTeamReposMatch[2], url);
  }

  const orgTeamInvitationsMatch = path.match(ORGS_TEAM_INVITATIONS_RE);
  if (orgTeamInvitationsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug/invitations.`);
    }
    return handleListOrgTeamInvitations(ctx, orgTeamInvitationsMatch[1], orgTeamInvitationsMatch[2], url);
  }

  const orgTeamMembershipMatch = path.match(ORGS_TEAM_MEMBERSHIP_RE);
  if (orgTeamMembershipMatch) {
    if (method === 'GET') {
      return handleGetOrgTeamMembership(ctx, orgTeamMembershipMatch[1], orgTeamMembershipMatch[2], orgTeamMembershipMatch[3], url);
    }
    if (method === 'PUT') {
      return handleAddOrgTeamMembership(ctx, orgTeamMembershipMatch[1], orgTeamMembershipMatch[2], orgTeamMembershipMatch[3], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleRemoveOrgTeamMembership(ctx, orgTeamMembershipMatch[1], orgTeamMembershipMatch[2], orgTeamMembershipMatch[3]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug/memberships/:username.`);
  }

  const orgTeamMemberMatch = path.match(ORGS_TEAM_MEMBER_RE);
  if (orgTeamMemberMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug/members/:username.`);
    }
    return handleCheckOrgTeamMember(ctx, orgTeamMemberMatch[1], orgTeamMemberMatch[2], orgTeamMemberMatch[3]);
  }

  const orgTeamMembersMatch = path.match(ORGS_TEAM_MEMBERS_RE);
  if (orgTeamMembersMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug/members.`);
    }
    return handleListOrgTeamMembers(ctx, orgTeamMembersMatch[1], orgTeamMembersMatch[2], url);
  }

  const orgTeamChildTeamsMatch = path.match(ORGS_TEAM_CHILD_TEAMS_RE);
  if (orgTeamChildTeamsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug/teams.`);
    }
    return handleListOrgTeamChildTeams(ctx, orgTeamChildTeamsMatch[1], orgTeamChildTeamsMatch[2], url);
  }

  const orgTeamMatch = path.match(ORGS_TEAM_RE);
  if (orgTeamMatch) {
    if (method === 'GET') { return handleGetOrgTeam(ctx, orgTeamMatch[1], orgTeamMatch[2], url); }
    if (method === 'PATCH') { return handleUpdateOrgTeam(ctx, orgTeamMatch[1], orgTeamMatch[2], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteOrgTeam(ctx, orgTeamMatch[1], orgTeamMatch[2]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams/:team_slug.`);
  }

  const orgTeamsMatch = path.match(ORGS_TEAMS_RE);
  if (orgTeamsMatch) {
    if (method === 'GET') { return handleListOrgTeams(ctx, orgTeamsMatch[1], url); }
    if (method === 'POST') { return handleCreateOrgTeam(ctx, orgTeamsMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/teams.`);
  }

  const orgFailedInvitationsMatch = path.match(ORGS_FAILED_INVITATIONS_RE);
  if (orgFailedInvitationsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/failed_invitations.`);
    }
    return handleListFailedOrgInvitations(ctx, orgFailedInvitationsMatch[1], url);
  }

  const orgInvitationTeamsMatch = path.match(ORGS_INVITATION_TEAMS_RE);
  if (orgInvitationTeamsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/invitations/:invitation_id/teams.`);
    }
    return handleListOrgInvitationTeams(ctx, orgInvitationTeamsMatch[1], orgInvitationTeamsMatch[2], url);
  }

  const orgInvitationMatch = path.match(ORGS_INVITATION_RE);
  if (orgInvitationMatch) {
    if (method !== 'DELETE') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/invitations/:invitation_id.`);
    }
    return handleCancelOrgInvitation(ctx, orgInvitationMatch[1], orgInvitationMatch[2]);
  }

  const orgInvitationsMatch = path.match(ORGS_INVITATIONS_RE);
  if (orgInvitationsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/invitations.`);
    }
    return handleListOrgInvitations(ctx, orgInvitationsMatch[1], url);
  }

  const orgBlockMatch = path.match(ORGS_BLOCK_RE);
  if (orgBlockMatch) {
    if (method === 'GET') { return handleCheckOrgBlockedUser(ctx, orgBlockMatch[1], orgBlockMatch[2]); }
    if (method === 'PUT') { return handleBlockOrgUser(ctx, orgBlockMatch[1], orgBlockMatch[2]); }
    if (method === 'DELETE') { return handleUnblockOrgUser(ctx, orgBlockMatch[1], orgBlockMatch[2]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/blocks/:username.`);
  }

  const orgBlocksMatch = path.match(ORGS_BLOCKS_RE);
  if (orgBlocksMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/blocks.`);
    }
    return handleListOrgBlockedUsers(ctx, orgBlocksMatch[1], url);
  }

  const orgHookDeliveryAttemptsMatch = path.match(ORGS_HOOK_DELIVERY_ATTEMPTS_RE);
  if (orgHookDeliveryAttemptsMatch) {
    if (method !== 'POST') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/hooks/:hook_id/deliveries/:delivery_id/attempts.`);
    }
    return handleRedeliverOrgWebhookDelivery(
      ctx,
      orgHookDeliveryAttemptsMatch[1],
      orgHookDeliveryAttemptsMatch[2],
      orgHookDeliveryAttemptsMatch[3],
    );
  }

  const orgHookDeliveryMatch = path.match(ORGS_HOOK_DELIVERY_RE);
  if (orgHookDeliveryMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/hooks/:hook_id/deliveries/:delivery_id.`);
    }
    return handleGetOrgWebhookDelivery(
      ctx,
      orgHookDeliveryMatch[1],
      orgHookDeliveryMatch[2],
      orgHookDeliveryMatch[3],
    );
  }

  const orgHookDeliveriesMatch = path.match(ORGS_HOOK_DELIVERIES_RE);
  if (orgHookDeliveriesMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/hooks/:hook_id/deliveries.`);
    }
    return handleListOrgWebhookDeliveries(ctx, orgHookDeliveriesMatch[1], orgHookDeliveriesMatch[2], url);
  }

  const orgHookConfigMatch = path.match(ORGS_HOOK_CONFIG_RE);
  if (orgHookConfigMatch) {
    if (method === 'GET') {
      return handleGetOrgWebhookConfig(ctx, orgHookConfigMatch[1], orgHookConfigMatch[2]);
    }
    if (method === 'PATCH') {
      return handleUpdateOrgWebhookConfig(ctx, orgHookConfigMatch[1], orgHookConfigMatch[2], reqBody);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/hooks/:hook_id/config.`);
  }

  const orgHookPingMatch = path.match(ORGS_HOOK_PING_RE);
  if (orgHookPingMatch) {
    if (method !== 'POST') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/hooks/:hook_id/pings.`);
    }
    return handlePingOrgWebhook(ctx, orgHookPingMatch[1], orgHookPingMatch[2]);
  }

  const orgHookMatch = path.match(ORGS_HOOK_RE);
  if (orgHookMatch) {
    if (method === 'GET') {
      return handleGetOrgWebhook(ctx, orgHookMatch[1], orgHookMatch[2], url);
    }
    if (method === 'PATCH') {
      return handleUpdateOrgWebhook(ctx, orgHookMatch[1], orgHookMatch[2], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleDeleteOrgWebhook(ctx, orgHookMatch[1], orgHookMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/hooks/:hook_id.`);
  }

  const orgHooksMatch = path.match(ORGS_HOOKS_RE);
  if (orgHooksMatch) {
    if (method === 'GET') {
      return handleListOrgWebhooks(ctx, orgHooksMatch[1], url);
    }
    if (method === 'POST') {
      return handleCreateOrgWebhook(ctx, orgHooksMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/hooks.`);
  }

  const orgCustomPropertySchemaMatch = path.match(ORGS_CUSTOM_PROPERTY_SCHEMA_RE);
  if (orgCustomPropertySchemaMatch) {
    if (method === 'GET') {
      return handleGetOrgCustomProperty(ctx, orgCustomPropertySchemaMatch[1], orgCustomPropertySchemaMatch[2], url);
    }
    if (method === 'PUT') {
      return handlePutOrgCustomProperty(ctx, orgCustomPropertySchemaMatch[1], orgCustomPropertySchemaMatch[2], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleDeleteOrgCustomProperty(ctx, orgCustomPropertySchemaMatch[1], orgCustomPropertySchemaMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/properties/schema/:custom_property_name.`);
  }

  const orgCustomPropertiesSchemaMatch = path.match(ORGS_CUSTOM_PROPERTIES_SCHEMA_RE);
  if (orgCustomPropertiesSchemaMatch) {
    if (method === 'GET') {
      return handleListOrgCustomProperties(ctx, orgCustomPropertiesSchemaMatch[1], url);
    }
    if (method === 'PATCH') {
      return handleUpsertOrgCustomProperties(ctx, orgCustomPropertiesSchemaMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/properties/schema.`);
  }

  const orgCustomPropertyValuesMatch = path.match(ORGS_CUSTOM_PROPERTY_VALUES_RE);
  if (orgCustomPropertyValuesMatch) {
    if (method === 'GET') {
      return handleListOrgCustomPropertyValues(ctx, orgCustomPropertyValuesMatch[1], url);
    }
    if (method === 'PATCH') {
      return handleUpdateOrgCustomPropertyValues(ctx, orgCustomPropertyValuesMatch[1], reqBody);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/properties/values.`);
  }

  const orgIssueFieldMatch = path.match(ORGS_ISSUE_FIELD_RE);
  if (orgIssueFieldMatch) {
    if (method === 'PATCH') {
      return handleUpdateOrgIssueField(ctx, orgIssueFieldMatch[1], orgIssueFieldMatch[2], reqBody);
    }
    if (method === 'DELETE') {
      return handleDeleteOrgIssueField(ctx, orgIssueFieldMatch[1], orgIssueFieldMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/issue-fields/:issue_field_id.`);
  }

  const orgIssueFieldsMatch = path.match(ORGS_ISSUE_FIELDS_RE);
  if (orgIssueFieldsMatch) {
    if (method === 'GET') {
      return handleListOrgIssueFields(ctx, orgIssueFieldsMatch[1], url);
    }
    if (method === 'POST') {
      return handleCreateOrgIssueField(ctx, orgIssueFieldsMatch[1], reqBody);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/issue-fields.`);
  }

  const orgIssueTypeMatch = path.match(ORGS_ISSUE_TYPE_RE);
  if (orgIssueTypeMatch) {
    if (method === 'PUT') {
      return handleUpdateOrgIssueType(ctx, orgIssueTypeMatch[1], orgIssueTypeMatch[2], reqBody);
    }
    if (method === 'DELETE') {
      return handleDeleteOrgIssueType(ctx, orgIssueTypeMatch[1], orgIssueTypeMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/issue-types/:issue_type_id.`);
  }

  const orgIssueTypesMatch = path.match(ORGS_ISSUE_TYPES_RE);
  if (orgIssueTypesMatch) {
    if (method === 'GET') {
      return handleListOrgIssueTypes(ctx, orgIssueTypesMatch[1], url);
    }
    if (method === 'POST') {
      return handleCreateOrgIssueType(ctx, orgIssueTypesMatch[1], reqBody);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/issue-types.`);
  }

  const orgOutsideCollaboratorMatch = path.match(ORGS_OUTSIDE_COLLABORATOR_RE);
  if (orgOutsideCollaboratorMatch) {
    if (method === 'PUT') {
      return handleConvertOrgMemberToOutsideCollaborator(ctx, orgOutsideCollaboratorMatch[1], orgOutsideCollaboratorMatch[2], reqBody);
    }
    if (method === 'DELETE') {
      return handleRemoveOutsideCollaborator(ctx, orgOutsideCollaboratorMatch[1], orgOutsideCollaboratorMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/outside_collaborators/:username.`);
  }

  const orgOutsideCollaboratorsMatch = path.match(ORGS_OUTSIDE_COLLABORATORS_RE);
  if (orgOutsideCollaboratorsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/outside_collaborators.`);
    }
    return handleListOutsideCollaborators(ctx, orgOutsideCollaboratorsMatch[1], url);
  }

  const orgMembershipMatch = path.match(ORGS_MEMBERSHIP_RE);
  if (orgMembershipMatch) {
    if (method === 'GET') {
      return handleGetOrgMembership(ctx, orgMembershipMatch[1], orgMembershipMatch[2], url);
    }
    if (method === 'PUT') {
      return handleSetOrgMembership(ctx, orgMembershipMatch[1], orgMembershipMatch[2], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleRemoveOrgMembership(ctx, orgMembershipMatch[1], orgMembershipMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/memberships/:username.`);
  }

  const orgMemberMatch = path.match(ORGS_MEMBER_RE);
  if (orgMemberMatch) {
    if (method === 'GET') {
      return handleCheckOrgMember(ctx, orgMemberMatch[1], orgMemberMatch[2]);
    }
    if (method === 'DELETE') {
      return handleRemoveOrgMembership(ctx, orgMemberMatch[1], orgMemberMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/members/:username.`);
  }

  const orgMembersMatch = path.match(ORGS_MEMBERS_RE);
  if (orgMembersMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/members.`);
    }
    return handleListOrgMembers(ctx, orgMembersMatch[1], url);
  }

  const orgPublicMemberMatch = path.match(ORGS_PUBLIC_MEMBER_RE);
  if (orgPublicMemberMatch) {
    if (method === 'GET') {
      return handleCheckPublicOrgMember(ctx, orgPublicMemberMatch[1], orgPublicMemberMatch[2]);
    }
    if (method === 'PUT') {
      return handleSetPublicOrgMembership(ctx, orgPublicMemberMatch[1], orgPublicMemberMatch[2]);
    }
    if (method === 'DELETE') {
      return handleRemovePublicOrgMembership(ctx, orgPublicMemberMatch[1], orgPublicMemberMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/public_members/:username.`);
  }

  const orgPublicMembersMatch = path.match(ORGS_PUBLIC_MEMBERS_RE);
  if (orgPublicMembersMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/public_members.`);
    }
    return handleListOrgMembers(ctx, orgPublicMembersMatch[1], url, true);
  }

  const orgReposMatch = path.match(ORGS_REPOS_RE);
  if (orgReposMatch) {
    if (method === 'GET') { return handleListOrgRepos(ctx, orgReposMatch[1], url); }
    if (method === 'POST') { return handleCreateOrgRepo(ctx, orgReposMatch[1], reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/repos.`);
  }

  const orgCodeScanningAlertsMatch = path.match(ORGS_CODE_SCANNING_ALERTS_RE);
  if (orgCodeScanningAlertsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/code-scanning/alerts.`);
    }
    return handleListOrgCodeScanningAlerts(ctx, orgCodeScanningAlertsMatch[1], url);
  }

  const orgDependabotAlertsMatch = path.match(ORGS_DEPENDABOT_ALERTS_RE);
  if (orgDependabotAlertsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/dependabot/alerts.`);
    }
    return handleListOrgDependabotAlerts(ctx, orgDependabotAlertsMatch[1], url);
  }

  const orgSecretScanningAlertsMatch = path.match(ORGS_SECRET_SCANNING_ALERTS_RE);
  if (orgSecretScanningAlertsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/secret-scanning/alerts.`);
    }
    return handleListOrgSecretScanningAlerts(ctx, orgSecretScanningAlertsMatch[1], url);
  }

  const orgSecurityAdvisoriesMatch = path.match(ORGS_SECURITY_ADVISORIES_RE);
  if (orgSecurityAdvisoriesMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/security-advisories.`);
    }
    return handleListOrgSecurityAdvisories(ctx, orgSecurityAdvisoriesMatch[1], url);
  }

  const orgIssuesMatch = path.match(ORGS_ISSUES_RE);
  if (orgIssuesMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org/issues.`);
    }
    return handleListOrgIssues(ctx, orgIssuesMatch[1], url, githubBodyMediaKind(options.accept));
  }

  const orgMatch = path.match(ORGS_RE);
  if (orgMatch) {
    if (method === 'GET') { return handleGetOrg(ctx, orgMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateOrg(ctx, orgMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /orgs/:org.`);
  }

  if (path === '/gists') {
    if (method === 'GET') { return handleListAuthenticatedGists(ctx, url); }
    if (method === 'POST') { return handleCreateGist(ctx, reqBody, url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists.`);
  }

  if (path === '/gists/public') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /gists/public.`);
    }
    return handleListPublicGists(ctx, url);
  }

  if (path === '/gists/starred') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /gists/starred.`);
    }
    return handleListStarredGists(ctx, url);
  }

  const gistCommitsMatch = path.match(GISTS_COMMITS_RE);
  if (gistCommitsMatch) {
    if (method === 'GET') { return handleListGistCommits(ctx, gistCommitsMatch[1], url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id/commits.`);
  }

  const gistCommentsMatch = path.match(GISTS_COMMENTS_RE);
  if (gistCommentsMatch) {
    if (method === 'GET') { return handleListGistComments(ctx, gistCommentsMatch[1], url); }
    if (method === 'POST') { return handleCreateGistComment(ctx, gistCommentsMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id/comments.`);
  }

  const gistCommentMatch = path.match(GISTS_COMMENT_RE);
  if (gistCommentMatch) {
    if (method === 'GET') { return handleGetGistComment(ctx, gistCommentMatch[1], gistCommentMatch[2], url); }
    if (method === 'PATCH') { return handleUpdateGistComment(ctx, gistCommentMatch[1], gistCommentMatch[2], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteGistComment(ctx, gistCommentMatch[1], gistCommentMatch[2]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id/comments/:comment_id.`);
  }

  const gistForksMatch = path.match(GISTS_FORKS_RE);
  if (gistForksMatch) {
    if (method === 'GET') { return handleListGistForks(ctx, gistForksMatch[1], url); }
    if (method === 'POST') { return handleForkGist(ctx, gistForksMatch[1], url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id/forks.`);
  }

  const gistStarMatch = path.match(GISTS_STAR_RE);
  if (gistStarMatch) {
    if (method === 'GET') { return handleCheckGistStar(ctx, gistStarMatch[1]); }
    if (method === 'PUT') { return handleStarGist(ctx, gistStarMatch[1]); }
    if (method === 'DELETE') { return handleUnstarGist(ctx, gistStarMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id/star.`);
  }

  const gistRawMatch = path.match(GISTS_RAW_RE);
  if (gistRawMatch) {
    if (method === 'GET') { return handleGetGistRawFile(ctx, gistRawMatch[1], gistRawMatch[2]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id/raw/:filename.`);
  }

  const gistRevisionMatch = path.match(GISTS_REVISION_RE);
  if (gistRevisionMatch) {
    if (method === 'GET') { return handleGetGistRevision(ctx, gistRevisionMatch[1], gistRevisionMatch[2], url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id/:sha.`);
  }

  const gistMatch = path.match(GISTS_RE);
  if (gistMatch) {
    if (method === 'GET') { return handleGetGist(ctx, gistMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateGist(ctx, gistMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteGist(ctx, gistMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /gists/:gist_id.`);
  }

  // -------------------------------------------------------------------------
  // /user/followers, /user/following, and /user/following/:did
  // -------------------------------------------------------------------------
  if (path === '/user') {
    if (method === 'GET') { return handleGetAuthenticatedUser(ctx, url); }
    if (method === 'PATCH') { return handleUpdateAuthenticatedUser(ctx, url, reqBody); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user.`);
  }

  const userAccountMatch = path.match(USER_ACCOUNT_RE);
  if (userAccountMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/:account_id.`);
    }
    return handleGetUserById(ctx, userAccountMatch[1], url);
  }

  if (path === '/user/repos') {
    if (method === 'GET') { return handleListAuthenticatedRepos(ctx, url); }
    if (method === 'POST') { return handleCreateUserRepo(ctx, reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/repos.`);
  }

  if (path === '/users') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users.`);
    }
    return handleListUsers(ctx, url);
  }

  if (path === '/user/issues') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/issues.`);
    }
    return handleListAuthenticatedUserIssues(ctx, url, githubBodyMediaKind(options.accept));
  }

  if (path === '/user/orgs') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/orgs.`);
    }
    return handleListAuthenticatedOrgs(ctx, url);
  }

  if (path === '/user/memberships/orgs') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/memberships/orgs.`);
    }
    return handleListAuthenticatedOrgMemberships(ctx, url);
  }

  const userMembershipOrgMatch = path.match(USER_MEMBERSHIP_ORG_RE);
  if (userMembershipOrgMatch) {
    if (method === 'GET') { return handleGetAuthenticatedOrgMembership(ctx, userMembershipOrgMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateAuthenticatedOrgMembership(ctx, userMembershipOrgMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/memberships/orgs/:org.`);
  }

  if (path === '/user/teams') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/teams.`);
    }
    return handleListAuthenticatedUserTeams(ctx, url);
  }

  if (path === '/user/emails') {
    if (method === 'GET') { return handleListAuthenticatedEmails(ctx, url); }
    if (method === 'POST') { return handleAddAuthenticatedEmails(ctx, reqBody); }
    if (method === 'DELETE') { return handleDeleteAuthenticatedEmails(ctx, reqBody); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/emails.`);
  }

  if (path === '/user/public_emails') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/public_emails.`);
    }
    return handleListAuthenticatedPublicEmails(ctx, url);
  }

  if (path === '/user/email/visibility') {
    if (method !== 'PATCH') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/email/visibility.`);
    }
    return handleSetPrimaryEmailVisibility(ctx, reqBody);
  }

  if (path === '/user/gpg_keys') {
    if (method === 'GET') { return handleListAuthenticatedGpgKeys(ctx, url); }
    if (method === 'POST') { return handleCreateAuthenticatedGpgKey(ctx, reqBody); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/gpg_keys.`);
  }

  const userGpgKeyMatch = path.match(USER_GPG_KEY_RE);
  if (userGpgKeyMatch) {
    if (method === 'GET') { return handleGetAuthenticatedGpgKey(ctx, userGpgKeyMatch[1]); }
    if (method === 'DELETE') { return handleDeleteAuthenticatedGpgKey(ctx, userGpgKeyMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/gpg_keys/:gpg_key_id.`);
  }

  if (path === '/user/social_accounts') {
    if (method === 'GET') { return handleListAuthenticatedSocialAccounts(ctx, url); }
    if (method === 'POST') { return handleAddAuthenticatedSocialAccounts(ctx, reqBody); }
    if (method === 'DELETE') { return handleDeleteAuthenticatedSocialAccounts(ctx, reqBody); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/social_accounts.`);
  }

  if (path === '/user/keys') {
    if (method === 'GET') { return handleListAuthenticatedSshKeys(ctx, url); }
    if (method === 'POST') { return handleCreateAuthenticatedSshKey(ctx, reqBody, url); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/keys.`);
  }

  const userKeyMatch = path.match(USER_KEY_RE);
  if (userKeyMatch) {
    if (method === 'GET') { return handleGetAuthenticatedSshKey(ctx, userKeyMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteAuthenticatedSshKey(ctx, userKeyMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/keys/:key_id.`);
  }

  if (path === '/user/ssh_signing_keys') {
    if (method === 'GET') { return handleListAuthenticatedSshSigningKeys(ctx, url); }
    if (method === 'POST') { return handleCreateAuthenticatedSshSigningKey(ctx, reqBody); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/ssh_signing_keys.`);
  }

  const userSshSigningKeyMatch = path.match(USER_SSH_SIGNING_KEY_RE);
  if (userSshSigningKeyMatch) {
    if (method === 'GET') { return handleGetAuthenticatedSshSigningKey(ctx, userSshSigningKeyMatch[1]); }
    if (method === 'DELETE') { return handleDeleteAuthenticatedSshSigningKey(ctx, userSshSigningKeyMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/ssh_signing_keys/:ssh_signing_key_id.`);
  }

  if (path === '/user/blocks') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/blocks.`);
    }
    return handleListBlockedUsers(ctx, url);
  }

  const userBlockMatch = path.match(USER_BLOCK_RE);
  if (userBlockMatch) {
    if (method === 'GET') { return handleCheckBlockedUser(ctx, userBlockMatch[1]); }
    if (method === 'PUT') { return handleBlockUser(ctx, userBlockMatch[1]); }
    if (method === 'DELETE') { return handleUnblockUser(ctx, userBlockMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/blocks/:username.`);
  }

  if (path === '/user/followers') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/followers.`);
    }
    return handleListFollowers(ctx, ctx.did, url);
  }

  if (path === '/user/following') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/following.`);
    }
    return handleListFollowing(ctx, ctx.did, url);
  }

  const userFollowingMatch = path.match(USER_FOLLOWING_RE);
  if (userFollowingMatch) {
    if (method === 'GET') { return handleCheckFollowing(ctx, ctx.did, userFollowingMatch[1]); }
    if (method === 'PUT') { return handleFollowUser(ctx, userFollowingMatch[1]); }
    if (method === 'DELETE') { return handleUnfollowUser(ctx, userFollowingMatch[1]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/following/:username.`);
  }

  // -------------------------------------------------------------------------
  // /user/starred and /user/starred/:did/:repo
  // -------------------------------------------------------------------------
  if (path === '/user/starred') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/starred.`);
    }
    return handleListStarredRepos(ctx, ctx.did, url);
  }

  if (path === '/user/subscriptions') {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /user/subscriptions.`);
    }
    return handleListSubscriptions(ctx, ctx.did, url);
  }

  const userStarredMatch = path.match(USER_STARRED_RE);
  if (userStarredMatch) {
    if (method === 'GET') { return handleCheckStarredRepo(ctx, userStarredMatch[1], userStarredMatch[2]); }
    if (method === 'PUT') { return handleStarRepo(ctx, userStarredMatch[1], userStarredMatch[2]); }
    if (method === 'DELETE') { return handleUnstarRepo(ctx, userStarredMatch[1], userStarredMatch[2]); }
    return jsonMethodNotAllowed(`${method} is not allowed on /user/starred/:owner/:repo.`);
  }

  // -------------------------------------------------------------------------
  // GET /users/:did/followers, /following, /following/:target_did
  // -------------------------------------------------------------------------
  const userReposMatch = path.match(USERS_REPOS_RE);
  if (userReposMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/repos.`);
    }
    return handleListUserRepos(ctx, userReposMatch[1], url);
  }

  const userGistsMatch = path.match(USERS_GISTS_RE);
  if (userGistsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/gists.`);
    }
    return handleListUserGists(ctx, userGistsMatch[1], url);
  }

  const userGpgKeysMatch = path.match(USERS_GPG_KEYS_RE);
  if (userGpgKeysMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/gpg_keys.`);
    }
    return handleListUserGpgKeys(ctx, userGpgKeysMatch[1], url);
  }

  const userSocialAccountsMatch = path.match(USERS_SOCIAL_ACCOUNTS_RE);
  if (userSocialAccountsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/social_accounts.`);
    }
    return handleListUserSocialAccounts(ctx, userSocialAccountsMatch[1], url);
  }

  const userKeysMatch = path.match(USERS_KEYS_RE);
  if (userKeysMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/keys.`);
    }
    return handleListUserSshKeys(ctx, userKeysMatch[1], url);
  }

  const userSshSigningKeysMatch = path.match(USERS_SSH_SIGNING_KEYS_RE);
  if (userSshSigningKeysMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/ssh_signing_keys.`);
    }
    return handleListUserSshSigningKeys(ctx, userSshSigningKeysMatch[1], url);
  }

  const userOrgsMatch = path.match(USERS_ORGS_RE);
  if (userOrgsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/orgs.`);
    }
    return handleListUserOrgs(ctx, userOrgsMatch[1], url);
  }

  const userHovercardMatch = path.match(USERS_HOVERCARD_RE);
  if (userHovercardMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/hovercard.`);
    }
    return handleGetUserHovercard(ctx, userHovercardMatch[1], url);
  }

  const userAttestationsBulkListMatch = path.match(USERS_ATTESTATIONS_BULK_LIST_RE);
  if (userAttestationsBulkListMatch) {
    if (method !== 'POST') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/attestations/bulk-list.`);
    }
    return handleBulkListUserAttestations(ctx, userAttestationsBulkListMatch[1], reqBody, url);
  }

  const userAttestationsDigestMatch = path.match(USERS_ATTESTATIONS_DIGEST_RE);
  if (userAttestationsDigestMatch) {
    if (method !== 'DELETE') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/attestations/digest/:subject_digest.`);
    }
    return handleDeleteUserAttestationsBySubjectDigest(
      ctx, userAttestationsDigestMatch[1], userAttestationsDigestMatch[2], url,
    );
  }

  const userAttestationIdMatch = path.match(USERS_ATTESTATION_ID_RE);
  if (userAttestationIdMatch) {
    if (method !== 'DELETE') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/attestations/:attestation_id.`);
    }
    return handleDeleteUserAttestationById(ctx, userAttestationIdMatch[1], userAttestationIdMatch[2], url);
  }

  const userAttestationsSubjectMatch = path.match(USERS_ATTESTATIONS_SUBJECT_RE);
  if (userAttestationsSubjectMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/attestations/:subject_digest.`);
    }
    return handleListUserAttestations(ctx, userAttestationsSubjectMatch[1], userAttestationsSubjectMatch[2], url);
  }

  const userAttestationsMatch = path.match(USERS_ATTESTATIONS_RE);
  if (userAttestationsMatch) {
    if (method !== 'DELETE') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/attestations.`);
    }
    return handleBulkDeleteUserAttestations(ctx, userAttestationsMatch[1], reqBody, url);
  }

  const userFollowsTargetMatch = path.match(USERS_FOLLOWING_TARGET_RE);
  if (userFollowsTargetMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/following/:target_did.`);
    }
    return handleCheckFollowing(ctx, userFollowsTargetMatch[1], userFollowsTargetMatch[2]);
  }

  const userEventsPublicMatch = path.match(USERS_EVENTS_PUBLIC_RE);
  if (userEventsPublicMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/events/public.`);
    }
    return handleListUserEvents(ctx, userEventsPublicMatch[1], url, true);
  }

  const userEventsMatch = path.match(USERS_EVENTS_RE);
  if (userEventsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/events.`);
    }
    return handleListUserEvents(ctx, userEventsMatch[1], url);
  }

  const userReceivedEventsPublicMatch = path.match(USERS_RECEIVED_EVENTS_PUBLIC_RE);
  if (userReceivedEventsPublicMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/received_events/public.`);
    }
    return handleListReceivedEvents(ctx, userReceivedEventsPublicMatch[1], url, true);
  }

  const userReceivedEventsMatch = path.match(USERS_RECEIVED_EVENTS_RE);
  if (userReceivedEventsMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/received_events.`);
    }
    return handleListReceivedEvents(ctx, userReceivedEventsMatch[1], url);
  }

  const userFollowersMatch = path.match(USERS_FOLLOWERS_RE);
  if (userFollowersMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/followers.`);
    }
    return handleListFollowers(ctx, userFollowersMatch[1], url);
  }

  const userFollowingListMatch = path.match(USERS_FOLLOWING_RE);
  if (userFollowingListMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/following.`);
    }
    return handleListFollowing(ctx, userFollowingListMatch[1], url);
  }

  // -------------------------------------------------------------------------
  // GET /users/:did/starred
  // -------------------------------------------------------------------------
  const userStarredListMatch = path.match(USERS_STARRED_RE);
  if (userStarredListMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/starred.`);
    }
    return handleListStarredRepos(ctx, userStarredListMatch[1], url);
  }

  const userSubscriptionsListMatch = path.match(USERS_SUBSCRIPTIONS_RE);
  if (userSubscriptionsListMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users/:did/subscriptions.`);
    }
    return handleListSubscriptions(ctx, userSubscriptionsListMatch[1], url);
  }

  // -------------------------------------------------------------------------
  // GET /users/:did
  // -------------------------------------------------------------------------
  const userMatch = path.match(USERS_RE);
  if (userMatch) {
    if (method !== 'GET') {
      return jsonMethodNotAllowed(`${method} is not allowed on /users endpoints.`);
    }
    return handleGetUser(ctx, userMatch[1], url);
  }

  // -------------------------------------------------------------------------
  // /repos/:did/:repo/...
  // -------------------------------------------------------------------------
  const repoMatch = path.match(REPOS_RE);
  if (!repoMatch) {
    return jsonNotFound('Not found');
  }

  const targetDid = repoMatch[1];
  const repoName = repoMatch[2];
  const rest = repoMatch[3] ?? '';

  // Try/catch — DID resolution failures should return 502.
  try {
    return await dispatchRepoRoute(ctx, targetDid, repoName, rest, url, method, reqBody, options);
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error';
    return {
      status  : 502,
      headers : baseHeaders(),
      body    : JSON.stringify({ message: `DWN error: ${msg}` }),
    };
  }
}

/**
 * Dispatch to the correct handler within the `/repos/:did/:repo/...`
 * namespace.  Considers both the URL path and the HTTP method.
 */
async function dispatchRepoRoute(
  ctx: AgentContext, targetDid: string, repoName: string,
  rest: string, url: URL, method: string, reqBody: Record<string, unknown>, options: ShimRequestOptions,
): Promise<JsonResponse> {
  // GET/PATCH/DELETE /repos/:did/:repo
  if (rest === '' || rest === '/') {
    if (method === 'GET') { return handleGetRepo(ctx, targetDid, repoName, url); }
    if (method === 'PATCH') { return handleUpdateRepo(ctx, targetDid, repoName, reqBody, url, options); }
    if (method === 'DELETE') { return handleDeleteRepo(ctx, targetDid, repoName, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /repos/:did/:repo.`);
  }

  // /repos/:did/:repo/forks
  if (rest === '/forks') {
    if (method === 'GET') { return handleListForks(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateFork(ctx, targetDid, repoName, reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /forks.`);
  }

  // POST /repos/:did/:repo/generate
  if (rest === '/generate') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /generate.`); }
    return handleGenerateRepoFromTemplate(ctx, targetDid, repoName, reqBody, url, options);
  }

  // POST /repos/:did/:repo/transfer
  if (rest === '/transfer') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /transfer.`); }
    return handleTransferRepo(ctx, targetDid, repoName, reqBody, url);
  }

  // GET /repos/:did/:repo/events
  if (rest === '/events') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /events.`); }
    return handleListRepoEvents(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/activity
  if (rest === '/activity') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /activity.`); }
    return handleListRepoActivity(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/readme
  if (rest === '/readme') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /readme.`); }
    const mediaKind = githubReadmeMediaKind(options.accept);
    const gitResponse = await tryGetGitReadme(ctx, targetDid, repoName, url, options, mediaKind);
    if (gitResponse.kind === 'response') { return gitResponse.response; }
    return handleGetReadme(ctx, targetDid, repoName, url, mediaKind);
  }

  // GET /repos/:did/:repo/readme/:dir
  const readmeDirectoryMatch = rest.match(/^\/readme\/(.+)$/);
  if (readmeDirectoryMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /readme/:dir.`); }
    const mediaKind = githubReadmeMediaKind(options.accept);
    const gitResponse = await tryGetGitReadmeInDirectory(
      ctx, targetDid, repoName, readmeDirectoryMatch[1], url, options, mediaKind,
    );
    if (gitResponse.kind === 'response') { return gitResponse.response; }
    return handleGetReadmeInDirectory(ctx, targetDid, repoName, readmeDirectoryMatch[1]);
  }

  // GET /repos/:did/:repo/license
  if (rest === '/license') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /license.`); }
    const mediaKind = githubLicenseMediaKind(options.accept);
    const gitResponse = await tryGetGitLicense(ctx, targetDid, repoName, url, options, mediaKind);
    if (gitResponse.kind === 'response') { return gitResponse.response; }
    return handleGetLicense(ctx, targetDid, repoName, url, mediaKind);
  }

  // GET /repos/:did/:repo/contents[/path]
  if (rest === '/contents' || rest === '/contents/') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /contents.`); }
    const mediaKind = githubContentMediaKind(options.accept);
    const gitResponse = await tryGetGitContents(ctx, targetDid, repoName, null, url, options, mediaKind);
    if (gitResponse.kind === 'response') { return gitResponse.response; }
    return handleGetContents(ctx, targetDid, repoName, null, url, mediaKind);
  }

  const contentsMatch = rest.match(/^\/contents\/(.+)$/);
  if (contentsMatch) {
    if (method === 'GET') {
      const mediaKind = githubContentMediaKind(options.accept);
      const gitResponse = await tryGetGitContents(ctx, targetDid, repoName, contentsMatch[1], url, options, mediaKind);
      if (gitResponse.kind === 'response') { return gitResponse.response; }
      return handleGetContents(ctx, targetDid, repoName, contentsMatch[1], url, mediaKind);
    }
    if (method === 'PUT') {
      return handlePutGitContents(ctx, targetDid, repoName, contentsMatch[1], reqBody, url, options);
    }
    if (method === 'DELETE') {
      return handleDeleteGitContents(ctx, targetDid, repoName, contentsMatch[1], reqBody, url, options);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /contents/:path.`);
  }

  // GET /repos/:did/:repo/raw/:ref/:path
  const rawContentMatch = rest.match(/^\/raw\/([^/]+)\/(.+)$/);
  if (rawContentMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /raw/:ref/:path.`); }
    const gitResponse = await tryGetGitRawContent(ctx, targetDid, repoName, rawContentMatch[1], rawContentMatch[2], options);
    if (gitResponse.kind === 'response') { return gitResponse.response; }
    return handleGetRawContent(ctx, targetDid, repoName, rawContentMatch[1], rawContentMatch[2]);
  }

  // GET /repos/:did/:repo/tarball[/:ref]
  if (rest === '/tarball') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /tarball.`); }
    return handleDownloadArchive(ctx, targetDid, repoName, 'tarball', null, url, options);
  }
  const tarballMatch = rest.match(/^\/tarball\/(.+)$/);
  if (tarballMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /tarball/:ref.`); }
    return handleDownloadArchive(ctx, targetDid, repoName, 'tarball', tarballMatch[1], url, options);
  }

  // GET /repos/:did/:repo/zipball[/:ref]
  if (rest === '/zipball') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /zipball.`); }
    return handleDownloadArchive(ctx, targetDid, repoName, 'zipball', null, url, options);
  }
  const zipballMatch = rest.match(/^\/zipball\/(.+)$/);
  if (zipballMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /zipball/:ref.`); }
    return handleDownloadArchive(ctx, targetDid, repoName, 'zipball', zipballMatch[1], url, options);
  }

  // GET /repos/:did/:repo/branches
  if (rest === '/branches') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /branches.`); }
    return handleListBranches(ctx, targetDid, repoName, url);
  }

  // /repos/:did/:repo/branches/:branch/protection/enforce_admins
  const enforceAdminsMatch = rest.match(/^\/branches\/(.+)\/protection\/enforce_admins$/);
  if (enforceAdminsMatch) {
    if (method === 'GET') { return handleGetAdminBranchProtection(ctx, targetDid, repoName, enforceAdminsMatch[1], url); }
    if (method === 'POST') { return handleSetAdminBranchProtection(ctx, targetDid, repoName, enforceAdminsMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteAdminBranchProtection(ctx, targetDid, repoName, enforceAdminsMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection/enforce_admins.`);
  }

  // /repos/:did/:repo/branches/:branch/protection/required_signatures
  const requiredSignaturesMatch = rest.match(/^\/branches\/(.+)\/protection\/required_signatures$/);
  if (requiredSignaturesMatch) {
    if (method === 'GET') { return handleGetCommitSignatureProtection(ctx, targetDid, repoName, requiredSignaturesMatch[1], url); }
    if (method === 'POST') { return handleCreateCommitSignatureProtection(ctx, targetDid, repoName, requiredSignaturesMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteCommitSignatureProtection(ctx, targetDid, repoName, requiredSignaturesMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection/required_signatures.`);
  }

  // /repos/:did/:repo/branches/:branch/protection/restrictions/:kind
  const branchRestrictionActorsMatch = rest.match(/^\/branches\/(.+)\/protection\/restrictions\/(users|teams|apps)$/);
  if (branchRestrictionActorsMatch) {
    const kind = branchRestrictionActorsMatch[2] as 'apps' | 'teams' | 'users';
    if (method === 'GET') {
      return handleListBranchAccessRestrictionActors(ctx, targetDid, repoName, branchRestrictionActorsMatch[1], kind, url);
    }
    if (method === 'POST') {
      return handleAddBranchAccessRestrictionActors(ctx, targetDid, repoName, branchRestrictionActorsMatch[1], kind, reqBody, url);
    }
    if (method === 'PUT') {
      return handleSetBranchAccessRestrictionActors(ctx, targetDid, repoName, branchRestrictionActorsMatch[1], kind, reqBody, url);
    }
    if (method === 'DELETE') {
      return handleRemoveBranchAccessRestrictionActors(ctx, targetDid, repoName, branchRestrictionActorsMatch[1], kind, reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection/restrictions/:kind.`);
  }

  // /repos/:did/:repo/branches/:branch/protection/restrictions
  const branchRestrictionsMatch = rest.match(/^\/branches\/(.+)\/protection\/restrictions$/);
  if (branchRestrictionsMatch) {
    if (method === 'GET') { return handleGetBranchAccessRestrictions(ctx, targetDid, repoName, branchRestrictionsMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteBranchAccessRestrictions(ctx, targetDid, repoName, branchRestrictionsMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection/restrictions.`);
  }

  // /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts
  const statusCheckContextsMatch = rest.match(/^\/branches\/(.+)\/protection\/required_status_checks\/contexts$/);
  if (statusCheckContextsMatch) {
    if (method === 'GET') { return handleListStatusCheckContexts(ctx, targetDid, repoName, statusCheckContextsMatch[1]); }
    if (method === 'POST') { return handleAddStatusCheckContexts(ctx, targetDid, repoName, statusCheckContextsMatch[1], reqBody); }
    if (method === 'PUT') { return handleSetStatusCheckContexts(ctx, targetDid, repoName, statusCheckContextsMatch[1], reqBody); }
    if (method === 'DELETE') { return handleRemoveStatusCheckContexts(ctx, targetDid, repoName, statusCheckContextsMatch[1], reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection/required_status_checks/contexts.`);
  }

  // /repos/:did/:repo/branches/:branch/protection/required_status_checks
  const requiredStatusChecksMatch = rest.match(/^\/branches\/(.+)\/protection\/required_status_checks$/);
  if (requiredStatusChecksMatch) {
    if (method === 'GET') { return handleGetRequiredStatusChecksProtection(ctx, targetDid, repoName, requiredStatusChecksMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateRequiredStatusChecksProtection(ctx, targetDid, repoName, requiredStatusChecksMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteRequiredStatusChecksProtection(ctx, targetDid, repoName, requiredStatusChecksMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection/required_status_checks.`);
  }

  // /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews
  const pullRequestReviewsProtectionMatch = rest.match(/^\/branches\/(.+)\/protection\/required_pull_request_reviews$/);
  if (pullRequestReviewsProtectionMatch) {
    if (method === 'GET') { return handleGetPullRequestReviewProtection(ctx, targetDid, repoName, pullRequestReviewsProtectionMatch[1], url); }
    if (method === 'PATCH') { return handleUpdatePullRequestReviewProtection(ctx, targetDid, repoName, pullRequestReviewsProtectionMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeletePullRequestReviewProtection(ctx, targetDid, repoName, pullRequestReviewsProtectionMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection/required_pull_request_reviews.`);
  }

  // /repos/:did/:repo/branches/:branch/protection
  const branchProtectionMatch = rest.match(/^\/branches\/(.+)\/protection$/);
  if (branchProtectionMatch) {
    if (method === 'GET') { return handleGetBranchProtection(ctx, targetDid, repoName, branchProtectionMatch[1], url); }
    if (method === 'PUT') { return handleUpdateBranchProtection(ctx, targetDid, repoName, branchProtectionMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteBranchProtection(ctx, targetDid, repoName, branchProtectionMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch/protection.`);
  }

  // GET /repos/:did/:repo/branches/:branch
  const branchMatch = rest.match(/^\/branches\/(.+)$/);
  if (branchMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /branches/:branch.`); }
    return handleGetBranch(ctx, targetDid, repoName, branchMatch[1], url);
  }

  // GET /repos/:did/:repo/tags
  if (rest === '/tags') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /tags.`); }
    return handleListTags(ctx, targetDid, repoName, url, options);
  }

  // GET /repos/:did/:repo/teams
  if (rest === '/teams') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /teams.`); }
    return handleListRepoTeams(ctx, targetDid, repoName, url);
  }

  // POST /repos/:did/:repo/git/refs
  if (rest === '/git/refs') {
    if (method === 'POST') { return handleCreateGitRef(ctx, targetDid, repoName, reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /git/refs.`);
  }

  // GET/PATCH/DELETE /repos/:did/:repo/git/ref/:ref (and /git/refs/:ref for tolerance)
  const gitRefMatch = rest.match(/^\/git\/refs?\/(.+)$/);
  if (gitRefMatch) {
    if (method === 'GET') { return handleGetGitRef(ctx, targetDid, repoName, gitRefMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateGitRef(ctx, targetDid, repoName, gitRefMatch[1], reqBody, url, options); }
    if (method === 'DELETE') { return handleDeleteGitRef(ctx, targetDid, repoName, gitRefMatch[1], options); }
    return jsonMethodNotAllowed(`${method} not allowed on /git/ref/:ref.`);
  }

  // GET /repos/:did/:repo/git/matching-refs/:ref
  const gitMatchingRefsMatch = rest.match(/^\/git\/matching-refs\/(.+)$/);
  if (gitMatchingRefsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /git/matching-refs/:ref.`); }
    return handleListMatchingGitRefs(ctx, targetDid, repoName, gitMatchingRefsMatch[1], url);
  }

  // POST /repos/:did/:repo/git/blobs
  if (rest === '/git/blobs') {
    if (method === 'POST') { return handleCreateGitBlob(ctx, targetDid, repoName, reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /git/blobs.`);
  }

  // GET /repos/:did/:repo/git/blobs/:sha
  const gitBlobMatch = rest.match(/^\/git\/blobs\/([^/]+)$/);
  if (gitBlobMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /git/blobs/:sha.`); }
    return handleGetGitBlob(ctx, targetDid, repoName, gitBlobMatch[1], url, options, githubBlobMediaKind(options.accept));
  }

  // POST /repos/:did/:repo/git/trees
  if (rest === '/git/trees') {
    if (method === 'POST') { return handleCreateGitTree(ctx, targetDid, repoName, reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /git/trees.`);
  }

  // GET /repos/:did/:repo/git/trees/:sha
  const gitTreeMatch = rest.match(/^\/git\/trees\/([^/]+)$/);
  if (gitTreeMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /git/trees/:sha.`); }
    return handleGetGitTree(ctx, targetDid, repoName, gitTreeMatch[1], url, options);
  }

  // POST /repos/:did/:repo/git/commits
  if (rest === '/git/commits') {
    if (method === 'POST') { return handleCreateGitCommit(ctx, targetDid, repoName, reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /git/commits.`);
  }

  // GET /repos/:did/:repo/git/commits/:sha
  const gitCommitMatch = rest.match(/^\/git\/commits\/([^/]+)$/);
  if (gitCommitMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /git/commits/:sha.`); }
    return handleGetGitCommit(ctx, targetDid, repoName, gitCommitMatch[1], url, options);
  }

  // POST /repos/:did/:repo/git/tags
  if (rest === '/git/tags') {
    if (method === 'POST') { return handleCreateGitTag(ctx, targetDid, repoName, reqBody, url, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /git/tags.`);
  }

  // GET /repos/:did/:repo/git/tags/:sha
  const gitTagMatch = rest.match(/^\/git\/tags\/([^/]+)$/);
  if (gitTagMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /git/tags/:sha.`); }
    return handleGetGitTag(ctx, targetDid, repoName, gitTagMatch[1], url, options);
  }

  // GET /repos/:did/:repo/commits
  if (rest === '/commits') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /commits.`); }
    return handleListRepoCommits(ctx, targetDid, repoName, url, options);
  }

  // /repos/:did/:repo/commits/:sha/comments
  const commitCommentsMatch = rest.match(/^\/commits\/(.+)\/comments$/);
  if (commitCommentsMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'GET') {
      return handleListCommitCommentsForSha(ctx, targetDid, repoName, commitCommentsMatch[1], url, bodyMediaKind);
    }
    if (method === 'POST') {
      return handleCreateCommitComment(ctx, targetDid, repoName, commitCommentsMatch[1], reqBody, url, bodyMediaKind);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /commits/:sha/comments.`);
  }

  // GET /repos/:did/:repo/contributors
  if (rest === '/contributors') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /contributors.`); }
    return handleListContributors(ctx, targetDid, repoName, url, options);
  }

  // GET /repos/:did/:repo/community/profile
  if (rest === '/community/profile') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /community/profile.`); }
    return handleGetCommunityProfile(ctx, targetDid, repoName, url, options);
  }

  // GET /repos/:did/:repo/stats/code_frequency
  if (rest === '/stats/code_frequency') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /stats/code_frequency.`); }
    return handleGetStatsCodeFrequency(ctx, targetDid, repoName, options);
  }

  // GET /repos/:did/:repo/stats/commit_activity
  if (rest === '/stats/commit_activity') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /stats/commit_activity.`); }
    return handleGetStatsCommitActivity(ctx, targetDid, repoName, options);
  }

  // GET /repos/:did/:repo/stats/contributors
  if (rest === '/stats/contributors') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /stats/contributors.`); }
    return handleGetStatsContributors(ctx, targetDid, repoName, url, options);
  }

  // GET /repos/:did/:repo/stats/participation
  if (rest === '/stats/participation') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /stats/participation.`); }
    return handleGetStatsParticipation(ctx, targetDid, repoName, options);
  }

  // GET /repos/:did/:repo/stats/punch_card
  if (rest === '/stats/punch_card') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /stats/punch_card.`); }
    return handleGetStatsPunchCard(ctx, targetDid, repoName, options);
  }

  // GET /repos/:did/:repo/traffic/clones
  if (rest === '/traffic/clones') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /traffic/clones.`); }
    return handleGetTrafficClones(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/traffic/popular/paths
  if (rest === '/traffic/popular/paths') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /traffic/popular/paths.`); }
    return handleGetTrafficPopularPaths(ctx, targetDid, repoName);
  }

  // GET /repos/:did/:repo/traffic/popular/referrers
  if (rest === '/traffic/popular/referrers') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /traffic/popular/referrers.`); }
    return handleGetTrafficPopularReferrers(ctx, targetDid, repoName);
  }

  // GET /repos/:did/:repo/traffic/views
  if (rest === '/traffic/views') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /traffic/views.`); }
    return handleGetTrafficViews(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/compare/:base...:head.{diff,patch}
  const compareTextMatch = rest.match(/^\/compare\/(.+)\.\.\.(.+)\.(diff|patch)$/);
  if (compareTextMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /compare/:base...:head.:format.`); }
    return handleCompareCommitText(
      ctx, targetDid, repoName, compareTextMatch[1], compareTextMatch[2],
      compareTextMatch[3] as 'diff' | 'patch',
      options,
    );
  }

  // GET /repos/:did/:repo/compare/:base...:head
  const compareMatch = rest.match(/^\/compare\/(.+)\.\.\.(.+)$/);
  if (compareMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /compare/:base...:head.`); }
    const textKind = githubTextMediaKind(options.accept);
    if (textKind) {
      return handleCompareCommitText(ctx, targetDid, repoName, compareMatch[1], compareMatch[2], textKind, options);
    }
    return handleCompareCommits(ctx, targetDid, repoName, compareMatch[1], compareMatch[2], url, options);
  }

  // GET /repos/:did/:repo/commits/:ref/status
  const combinedStatusMatch = rest.match(/^\/commits\/(.+)\/status$/);
  if (combinedStatusMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /commits/:ref/status.`); }
    return handleGetCombinedStatus(ctx, targetDid, repoName, combinedStatusMatch[1], url);
  }

  // GET /repos/:did/:repo/commits/:ref/statuses
  const commitStatusesMatch = rest.match(/^\/commits\/(.+)\/statuses$/);
  if (commitStatusesMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /commits/:ref/statuses.`); }
    return handleListCommitStatuses(ctx, targetDid, repoName, commitStatusesMatch[1], url);
  }

  // GET /repos/:did/:repo/commits/:ref/check-suites
  const commitCheckSuitesMatch = rest.match(/^\/commits\/(.+)\/check-suites$/);
  if (commitCheckSuitesMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /commits/:ref/check-suites.`); }
    return handleListCheckSuitesForRef(ctx, targetDid, repoName, commitCheckSuitesMatch[1], url);
  }

  // GET /repos/:did/:repo/commits/:ref/check-runs
  const commitCheckRunsMatch = rest.match(/^\/commits\/(.+)\/check-runs$/);
  if (commitCheckRunsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /commits/:ref/check-runs.`); }
    return handleListCheckRunsForRef(ctx, targetDid, repoName, commitCheckRunsMatch[1], url);
  }

  // GET /repos/:did/:repo/commits/:ref
  const repoCommitMatch = rest.match(/^\/commits\/(.+)$/);
  if (repoCommitMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /commits/:ref.`); }
    const mediaKind = githubCommitMediaKind(options.accept);
    if (mediaKind) {
      return handleGetRepoCommitMedia(ctx, targetDid, repoName, repoCommitMatch[1], mediaKind, options);
    }
    return handleGetRepoCommit(ctx, targetDid, repoName, repoCommitMatch[1], url, options);
  }

  // /repos/:did/:repo/topics
  if (rest === '/topics') {
    if (method === 'GET') { return handleGetTopics(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleReplaceTopics(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /topics.`);
  }

  // GET /repos/:did/:repo/languages
  if (rest === '/languages') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /languages.`); }
    return handleGetLanguages(ctx, targetDid, repoName);
  }

  // GET /repos/:did/:repo/issue-types
  if (rest === '/issue-types') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /issue-types.`); }
    return handleListRepositoryIssueTypes(ctx, targetDid, repoName);
  }

  // /repos/:did/:repo/properties/values
  if (rest === '/properties/values') {
    if (method === 'GET') { return handleGetRepositoryCustomProperties(ctx, targetDid, repoName); }
    if (method === 'PATCH') { return handleUpdateRepositoryCustomProperties(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /properties/values.`);
  }

  // POST /repos/:did/:repo/dispatches
  if (rest === '/dispatches') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /dispatches.`); }
    return handleCreateRepositoryDispatch(ctx, targetDid, repoName, reqBody);
  }

  // GET /repos/:did/:repo/codeowners/errors
  if (rest === '/codeowners/errors') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /codeowners/errors.`); }
    return handleListCodeownersErrors(ctx, targetDid, repoName);
  }

  // GET /repos/:did/:repo/hash-algorithm
  if (rest === '/hash-algorithm') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /hash-algorithm.`); }
    return handleGetRepositoryHashAlgorithm(ctx, targetDid, repoName);
  }

  // /repos/:did/:repo/attestations
  if (rest === '/attestations') {
    if (method === 'POST') { return handleCreateRepositoryAttestation(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /attestations.`);
  }

  // GET /repos/:did/:repo/attestations/:subject_digest
  const attestationMatch = rest.match(/^\/attestations\/(.+)$/);
  if (attestationMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /attestations/:subject_digest.`); }
    return handleListRepositoryAttestations(ctx, targetDid, repoName, attestationMatch[1], url);
  }

  // /repos/:did/:repo/keys
  if (rest === '/keys') {
    if (method === 'GET') { return handleListDeployKeys(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateDeployKey(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /keys.`);
  }

  // /repos/:did/:repo/keys/:key_id
  const deployKeyMatch = rest.match(/^\/keys\/(\d+)$/);
  if (deployKeyMatch) {
    if (method === 'GET') { return handleGetDeployKey(ctx, targetDid, repoName, deployKeyMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteDeployKey(ctx, targetDid, repoName, deployKeyMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /keys/:key_id.`);
  }

  // /repos/:did/:repo/autolinks
  if (rest === '/autolinks') {
    if (method === 'GET') { return handleListAutolinks(ctx, targetDid, repoName); }
    if (method === 'POST') { return handleCreateAutolink(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /autolinks.`);
  }

  // /repos/:did/:repo/autolinks/:autolink_id
  const autolinkMatch = rest.match(/^\/autolinks\/(\d+)$/);
  if (autolinkMatch) {
    if (method === 'GET') { return handleGetAutolink(ctx, targetDid, repoName, autolinkMatch[1]); }
    if (method === 'DELETE') { return handleDeleteAutolink(ctx, targetDid, repoName, autolinkMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /autolinks/:autolink_id.`);
  }

  // /repos/:did/:repo/interaction-limits
  if (rest === '/interaction-limits') {
    if (method === 'GET') { return handleGetInteractionLimit(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleSetInteractionLimit(ctx, targetDid, repoName, reqBody); }
    if (method === 'DELETE') { return handleDeleteInteractionLimit(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /interaction-limits.`);
  }

  // /repos/:did/:repo/vulnerability-alerts
  if (rest === '/vulnerability-alerts') {
    if (method === 'GET') { return handleCheckVulnerabilityAlerts(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleEnableVulnerabilityAlerts(ctx, targetDid, repoName); }
    if (method === 'DELETE') { return handleDisableVulnerabilityAlerts(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /vulnerability-alerts.`);
  }

  // /repos/:did/:repo/automated-security-fixes
  if (rest === '/automated-security-fixes') {
    if (method === 'GET') { return handleCheckAutomatedSecurityFixes(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleEnableAutomatedSecurityFixes(ctx, targetDid, repoName); }
    if (method === 'DELETE') { return handleDisableAutomatedSecurityFixes(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /automated-security-fixes.`);
  }

  // /repos/:did/:repo/immutable-releases
  if (rest === '/immutable-releases') {
    if (method === 'GET') { return handleCheckImmutableReleases(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleEnableImmutableReleases(ctx, targetDid, repoName); }
    if (method === 'DELETE') { return handleDisableImmutableReleases(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /immutable-releases.`);
  }

  // /repos/:did/:repo/private-vulnerability-reporting
  if (rest === '/private-vulnerability-reporting') {
    if (method === 'GET') { return handleGetPrivateVulnerabilityReporting(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleEnablePrivateVulnerabilityReporting(ctx, targetDid, repoName); }
    if (method === 'DELETE') { return handleDisablePrivateVulnerabilityReporting(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /private-vulnerability-reporting.`);
  }

  // GET/POST /repos/:did/:repo/security-advisories
  if (rest === '/security-advisories') {
    if (method === 'GET') { return handleListSecurityAdvisories(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateSecurityAdvisory(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /security-advisories.`);
  }

  // POST /repos/:did/:repo/security-advisories/reports
  if (rest === '/security-advisories/reports') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /security-advisories/reports.`); }
    return handlePrivatelyReportSecurityVulnerability(ctx, targetDid, repoName, reqBody, url);
  }

  // POST /repos/:did/:repo/security-advisories/:ghsa_id/cve
  const securityAdvisoryCveMatch = rest.match(/^\/security-advisories\/([^/]+)\/cve$/);
  if (securityAdvisoryCveMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /security-advisories/:ghsa_id/cve.`); }
    return handleRequestSecurityAdvisoryCve(ctx, targetDid, repoName, securityAdvisoryCveMatch[1]);
  }

  // POST /repos/:did/:repo/security-advisories/:ghsa_id/forks
  const securityAdvisoryForksMatch = rest.match(/^\/security-advisories\/([^/]+)\/forks$/);
  if (securityAdvisoryForksMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /security-advisories/:ghsa_id/forks.`); }
    return handleCreateSecurityAdvisoryPrivateFork(ctx, targetDid, repoName, securityAdvisoryForksMatch[1]);
  }

  // GET/PATCH /repos/:did/:repo/security-advisories/:ghsa_id
  const securityAdvisoryMatch = rest.match(/^\/security-advisories\/([^/]+)$/);
  if (securityAdvisoryMatch) {
    if (method === 'GET') { return handleGetSecurityAdvisory(ctx, targetDid, repoName, securityAdvisoryMatch[1], url); }
    if (method === 'PATCH') {
      return handleUpdateSecurityAdvisory(ctx, targetDid, repoName, securityAdvisoryMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /security-advisories/:ghsa_id.`);
  }

  // GET /repos/:did/:repo/secret-scanning/alerts
  if (rest === '/secret-scanning/alerts') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /secret-scanning/alerts.`); }
    return handleListSecretScanningAlerts(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/secret-scanning/scan-history
  if (rest === '/secret-scanning/scan-history') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /secret-scanning/scan-history.`); }
    return handleGetSecretScanningScanHistory(ctx, targetDid, repoName);
  }

  // POST /repos/:did/:repo/secret-scanning/push-protection-bypasses
  if (rest === '/secret-scanning/push-protection-bypasses') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /secret-scanning/push-protection-bypasses.`); }
    return handleCreateSecretScanningPushProtectionBypass(ctx, targetDid, repoName, reqBody);
  }

  // GET /repos/:did/:repo/secret-scanning/alerts/:alert_number/locations
  const secretScanningAlertLocationsMatch = rest.match(/^\/secret-scanning\/alerts\/(\d+)\/locations$/);
  if (secretScanningAlertLocationsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /secret-scanning/alerts/:alert_number/locations.`); }
    return handleListSecretScanningAlertLocations(ctx, targetDid, repoName, secretScanningAlertLocationsMatch[1], url);
  }

  // GET/PATCH /repos/:did/:repo/secret-scanning/alerts/:alert_number
  const secretScanningAlertMatch = rest.match(/^\/secret-scanning\/alerts\/(\d+)$/);
  if (secretScanningAlertMatch) {
    if (method === 'GET') { return handleGetSecretScanningAlert(ctx, targetDid, repoName, secretScanningAlertMatch[1], url); }
    if (method === 'PATCH') {
      return handleUpdateSecretScanningAlert(ctx, targetDid, repoName, secretScanningAlertMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /secret-scanning/alerts/:alert_number.`);
  }

  // GET /repos/:did/:repo/code-scanning/alerts
  if (rest === '/code-scanning/alerts') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /code-scanning/alerts.`); }
    return handleListCodeScanningAlerts(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/code-scanning/alerts/:alert_number/instances
  const codeScanningAlertInstancesMatch = rest.match(/^\/code-scanning\/alerts\/(\d+)\/instances$/);
  if (codeScanningAlertInstancesMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /code-scanning/alerts/:alert_number/instances.`); }
    return handleListCodeScanningAlertInstances(ctx, targetDid, repoName, codeScanningAlertInstancesMatch[1], url);
  }

  // GET/PATCH /repos/:did/:repo/code-scanning/alerts/:alert_number
  const codeScanningAlertMatch = rest.match(/^\/code-scanning\/alerts\/(\d+)$/);
  if (codeScanningAlertMatch) {
    if (method === 'GET') { return handleGetCodeScanningAlert(ctx, targetDid, repoName, codeScanningAlertMatch[1], url); }
    if (method === 'PATCH') {
      return handleUpdateCodeScanningAlert(ctx, targetDid, repoName, codeScanningAlertMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /code-scanning/alerts/:alert_number.`);
  }

  // GET /repos/:did/:repo/dependabot/alerts
  if (rest === '/dependabot/alerts') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /dependabot/alerts.`); }
    return handleListDependabotAlerts(ctx, targetDid, repoName, url);
  }

  // GET/PATCH /repos/:did/:repo/dependabot/alerts/:alert_number
  const dependabotAlertMatch = rest.match(/^\/dependabot\/alerts\/(\d+)$/);
  if (dependabotAlertMatch) {
    if (method === 'GET') { return handleGetDependabotAlert(ctx, targetDid, repoName, dependabotAlertMatch[1], url); }
    if (method === 'PATCH') {
      return handleUpdateDependabotAlert(ctx, targetDid, repoName, dependabotAlertMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /dependabot/alerts/:alert_number.`);
  }

  // GET /repos/:did/:repo/dependency-graph/sbom
  if (rest === '/dependency-graph/sbom') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /dependency-graph/sbom.`); }
    return handleExportDependencyGraphSbom(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/dependency-graph/sbom/generate-report
  if (rest === '/dependency-graph/sbom/generate-report') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /dependency-graph/sbom/generate-report.`); }
    return handleGenerateDependencyGraphSbom(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/dependency-graph/sbom/fetch-report/:sbom_uuid
  const dependencyGraphSbomFetchMatch = rest.match(/^\/dependency-graph\/sbom\/fetch-report\/([^/]+)$/);
  if (dependencyGraphSbomFetchMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /dependency-graph/sbom/fetch-report/:sbom_uuid.`); }
    return handleFetchDependencyGraphSbom(ctx, targetDid, repoName, dependencyGraphSbomFetchMatch[1], url);
  }

  // GET /repos/:did/:repo/rules/branches/:branch
  const branchRulesMatch = rest.match(/^\/rules\/branches\/(.+)$/);
  if (branchRulesMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /rules/branches/:branch.`); }
    return handleGetRulesForBranch(ctx, targetDid, repoName, branchRulesMatch[1], url);
  }

  // /repos/:did/:repo/rulesets
  if (rest === '/rulesets') {
    if (method === 'GET') { return handleListRepositoryRulesets(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateRepositoryRuleset(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /rulesets.`);
  }

  // GET /repos/:did/:repo/rulesets/rule-suites
  if (rest === '/rulesets/rule-suites') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /rulesets/rule-suites.`); }
    return handleListRepositoryRuleSuites(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/rulesets/rule-suites/:rule_suite_id
  const ruleSuiteMatch = rest.match(/^\/rulesets\/rule-suites\/(\d+)$/);
  if (ruleSuiteMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /rulesets/rule-suites/:rule_suite_id.`); }
    return handleGetRepositoryRuleSuite(ctx, targetDid, repoName, ruleSuiteMatch[1]);
  }

  // GET /repos/:did/:repo/rulesets/:ruleset_id/history/:version_id
  const rulesetVersionMatch = rest.match(/^\/rulesets\/(\d+)\/history\/(\d+)$/);
  if (rulesetVersionMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /rulesets/:ruleset_id/history/:version_id.`); }
    return handleGetRepositoryRulesetVersion(ctx, targetDid, repoName, rulesetVersionMatch[1], rulesetVersionMatch[2], url);
  }

  // GET /repos/:did/:repo/rulesets/:ruleset_id/history
  const rulesetHistoryMatch = rest.match(/^\/rulesets\/(\d+)\/history$/);
  if (rulesetHistoryMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /rulesets/:ruleset_id/history.`); }
    return handleListRepositoryRulesetHistory(ctx, targetDid, repoName, rulesetHistoryMatch[1], url);
  }

  // /repos/:did/:repo/rulesets/:ruleset_id
  const rulesetMatch = rest.match(/^\/rulesets\/(\d+)$/);
  if (rulesetMatch) {
    if (method === 'GET') { return handleGetRepositoryRuleset(ctx, targetDid, repoName, rulesetMatch[1], url); }
    if (method === 'PUT') { return handleUpdateRepositoryRuleset(ctx, targetDid, repoName, rulesetMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteRepositoryRuleset(ctx, targetDid, repoName, rulesetMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /rulesets/:ruleset_id.`);
  }

  // GET /repos/:did/:repo/assignees
  if (rest === '/assignees') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /assignees.`); }
    return handleListAssignees(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/assignees/:did
  const assigneeMatch = rest.match(/^\/assignees\/(.+)$/);
  if (assigneeMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /assignees/:did.`); }
    return handleCheckAssignee(ctx, targetDid, repoName, assigneeMatch[1]);
  }

  // GET /repos/:did/:repo/collaborators
  if (rest === '/collaborators') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /collaborators.`); }
    return handleListCollaborators(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/collaborators/:did/permission
  const collaboratorPermissionMatch = rest.match(/^\/collaborators\/(.+)\/permission$/);
  if (collaboratorPermissionMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /collaborators/:did/permission.`); }
    return handleGetCollaboratorPermission(ctx, targetDid, repoName, collaboratorPermissionMatch[1], url);
  }

  // /repos/:did/:repo/collaborators/:did
  const collaboratorMatch = rest.match(/^\/collaborators\/(.+)$/);
  if (collaboratorMatch) {
    if (method === 'GET') { return handleCheckCollaborator(ctx, targetDid, repoName, collaboratorMatch[1]); }
    if (method === 'PUT') { return handleAddCollaborator(ctx, targetDid, repoName, collaboratorMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleRemoveCollaborator(ctx, targetDid, repoName, collaboratorMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /collaborators/:did.`);
  }

  // POST /repos/:did/:repo/statuses/:sha
  const createStatusMatch = rest.match(/^\/statuses\/([^/]+)$/);
  if (createStatusMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /statuses/:sha.`); }
    return handleCreateCommitStatus(ctx, targetDid, repoName, createStatusMatch[1], reqBody, url);
  }

  // POST /repos/:did/:repo/check-suites
  if (rest === '/check-suites') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /check-suites.`); }
    return handleCreateCheckSuite(ctx, targetDid, repoName, reqBody, url);
  }

  // GET /repos/:did/:repo/check-suites/:id/check-runs
  const suiteRunsMatch = rest.match(/^\/check-suites\/(\d+)\/check-runs$/);
  if (suiteRunsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /check-suites/:id/check-runs.`); }
    return handleListCheckRunsForSuite(ctx, targetDid, repoName, suiteRunsMatch[1], url);
  }

  // POST /repos/:did/:repo/check-suites/:id/rerequest
  const rerequestSuiteMatch = rest.match(/^\/check-suites\/(\d+)\/rerequest$/);
  if (rerequestSuiteMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /check-suites/:id/rerequest.`); }
    return handleRerequestCheckSuite(ctx, targetDid, repoName, rerequestSuiteMatch[1]);
  }

  // GET /repos/:did/:repo/check-suites/:id
  const checkSuiteMatch = rest.match(/^\/check-suites\/(\d+)$/);
  if (checkSuiteMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /check-suites/:id.`); }
    return handleGetCheckSuite(ctx, targetDid, repoName, checkSuiteMatch[1], url);
  }

  // POST /repos/:did/:repo/check-runs
  if (rest === '/check-runs') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /check-runs.`); }
    return handleCreateCheckRun(ctx, targetDid, repoName, reqBody, url);
  }

  // GET /repos/:did/:repo/check-runs/:id/annotations
  const checkRunAnnotationsMatch = rest.match(/^\/check-runs\/(\d+)\/annotations$/);
  if (checkRunAnnotationsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /check-runs/:id/annotations.`); }
    return handleListCheckRunAnnotations(ctx, targetDid, repoName, checkRunAnnotationsMatch[1], url);
  }

  // POST /repos/:did/:repo/check-runs/:id/rerequest
  const rerequestRunMatch = rest.match(/^\/check-runs\/(\d+)\/rerequest$/);
  if (rerequestRunMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /check-runs/:id/rerequest.`); }
    return handleRerequestCheckRun(ctx, targetDid, repoName, rerequestRunMatch[1]);
  }

  // /repos/:did/:repo/check-runs/:id
  const checkRunMatch = rest.match(/^\/check-runs\/(\d+)$/);
  if (checkRunMatch) {
    if (method === 'PATCH') { return handleUpdateCheckRun(ctx, targetDid, repoName, checkRunMatch[1], reqBody, url); }
    if (method === 'GET') { return handleGetCheckRun(ctx, targetDid, repoName, checkRunMatch[1], url); }
    return jsonMethodNotAllowed(`${method} not allowed on /check-runs/:id.`);
  }

  // GET /repos/:did/:repo/actions/artifacts
  if (rest === '/actions/artifacts') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/artifacts.`); }
    return handleListArtifacts(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/actions/artifacts/:artifact_id/:archive_format
  const artifactDownloadMatch = rest.match(/^\/actions\/artifacts\/(\d+)\/([^/]+)$/);
  if (artifactDownloadMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/artifacts/:artifact_id/:archive_format.`); }
    return handleDownloadArtifact(ctx, targetDid, repoName, artifactDownloadMatch[1], artifactDownloadMatch[2], url);
  }

  // GET/DELETE /repos/:did/:repo/actions/artifacts/:artifact_id
  const artifactMatch = rest.match(/^\/actions\/artifacts\/(\d+)$/);
  if (artifactMatch) {
    if (method === 'GET') { return handleGetArtifact(ctx, targetDid, repoName, artifactMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteArtifact(ctx, targetDid, repoName, artifactMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/artifacts/:artifact_id.`);
  }

  // GET/PUT /repos/:did/:repo/actions/cache/retention-limit
  if (rest === '/actions/cache/retention-limit') {
    if (method === 'GET') { return handleGetActionsCacheRetentionLimit(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleSetActionsCacheRetentionLimit(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/cache/retention-limit.`);
  }

  // GET/PUT /repos/:did/:repo/actions/cache/storage-limit
  if (rest === '/actions/cache/storage-limit') {
    if (method === 'GET') { return handleGetActionsCacheStorageLimit(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleSetActionsCacheStorageLimit(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/cache/storage-limit.`);
  }

  // GET /repos/:did/:repo/actions/cache/usage
  if (rest === '/actions/cache/usage') {
    if (method === 'GET') { return handleGetActionsCacheUsage(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/cache/usage.`);
  }

  // GET/DELETE /repos/:did/:repo/actions/caches
  if (rest === '/actions/caches') {
    if (method === 'GET') { return handleListActionsCaches(ctx, targetDid, repoName, url); }
    if (method === 'DELETE') { return handleDeleteActionsCachesByKey(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/caches.`);
  }

  // DELETE /repos/:did/:repo/actions/caches/:cache_id
  const actionsCacheMatch = rest.match(/^\/actions\/caches\/(\d+)$/);
  if (actionsCacheMatch) {
    if (method === 'DELETE') { return handleDeleteActionsCacheById(ctx, targetDid, repoName, actionsCacheMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/caches/:cache_id.`);
  }

  // GET/PUT /repos/:did/:repo/actions/permissions/selected-actions
  if (rest === '/actions/permissions/selected-actions') {
    if (method === 'GET') { return handleGetActionsSelectedActions(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleSetActionsSelectedActions(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/permissions/selected-actions.`);
  }

  // GET/PUT /repos/:did/:repo/actions/permissions/workflow
  if (rest === '/actions/permissions/workflow') {
    if (method === 'GET') { return handleGetActionsWorkflowPermissions(ctx, targetDid, repoName); }
    if (method === 'PUT') { return handleSetActionsWorkflowPermissions(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/permissions/workflow.`);
  }

  // GET/PUT /repos/:did/:repo/actions/permissions
  if (rest === '/actions/permissions') {
    if (method === 'GET') { return handleGetActionsPermissions(ctx, targetDid, repoName, url); }
    if (method === 'PUT') { return handleSetActionsPermissions(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/permissions.`);
  }

  // GET /repos/:did/:repo/actions/secrets/public-key
  if (rest === '/actions/secrets/public-key') {
    if (method === 'GET') { return handleGetRepositorySecretsPublicKey(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/secrets/public-key.`);
  }

  // GET /repos/:did/:repo/actions/secrets
  if (rest === '/actions/secrets') {
    if (method === 'GET') { return handleListRepositorySecrets(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/secrets.`);
  }

  // GET/PUT/DELETE /repos/:did/:repo/actions/secrets/:secret_name
  const repositorySecretMatch = rest.match(/^\/actions\/secrets\/([^/]+)$/);
  if (repositorySecretMatch) {
    if (method === 'GET') {
      return handleGetRepositorySecret(ctx, targetDid, repoName, repositorySecretMatch[1]);
    }
    if (method === 'PUT') {
      return handleCreateOrUpdateRepositorySecret(ctx, targetDid, repoName, repositorySecretMatch[1], reqBody);
    }
    if (method === 'DELETE') {
      return handleDeleteRepositorySecret(ctx, targetDid, repoName, repositorySecretMatch[1]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/secrets/:secret_name.`);
  }

  // GET/POST /repos/:did/:repo/actions/variables
  if (rest === '/actions/variables') {
    if (method === 'GET') { return handleListRepositoryVariables(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateRepositoryVariable(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/variables.`);
  }

  // GET/PATCH/DELETE /repos/:did/:repo/actions/variables/:name
  const repositoryVariableMatch = rest.match(/^\/actions\/variables\/([^/]+)$/);
  if (repositoryVariableMatch) {
    if (method === 'GET') {
      return handleGetRepositoryVariable(ctx, targetDid, repoName, repositoryVariableMatch[1]);
    }
    if (method === 'PATCH') {
      return handleUpdateRepositoryVariable(ctx, targetDid, repoName, repositoryVariableMatch[1], reqBody);
    }
    if (method === 'DELETE') {
      return handleDeleteRepositoryVariable(ctx, targetDid, repoName, repositoryVariableMatch[1]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/variables/:name.`);
  }

  // GET /repos/:did/:repo/actions/workflows
  if (rest === '/actions/workflows') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/workflows.`); }
    return handleListWorkflows(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/actions/workflows/:workflow_id/runs
  const workflowRunsMatch = rest.match(/^\/actions\/workflows\/([^/]+)\/runs$/);
  if (workflowRunsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/workflows/:workflow_id/runs.`); }
    return handleListWorkflowRunsForWorkflow(ctx, targetDid, repoName, workflowRunsMatch[1], url);
  }

  // GET /repos/:did/:repo/actions/workflows/:workflow_id/timing
  const workflowTimingMatch = rest.match(/^\/actions\/workflows\/([^/]+)\/timing$/);
  if (workflowTimingMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/workflows/:workflow_id/timing.`); }
    return handleGetWorkflowUsage(ctx, targetDid, repoName, workflowTimingMatch[1]);
  }

  // PUT /repos/:did/:repo/actions/workflows/:workflow_id/disable
  const workflowDisableMatch = rest.match(/^\/actions\/workflows\/([^/]+)\/disable$/);
  if (workflowDisableMatch) {
    if (method !== 'PUT') { return jsonMethodNotAllowed(`${method} not allowed on /actions/workflows/:workflow_id/disable.`); }
    return handleDisableWorkflow(ctx, targetDid, repoName, workflowDisableMatch[1]);
  }

  // POST /repos/:did/:repo/actions/workflows/:workflow_id/dispatches
  const workflowDispatchMatch = rest.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/);
  if (workflowDispatchMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /actions/workflows/:workflow_id/dispatches.`); }
    return handleCreateWorkflowDispatch(ctx, targetDid, repoName, workflowDispatchMatch[1], reqBody, url);
  }

  // PUT /repos/:did/:repo/actions/workflows/:workflow_id/enable
  const workflowEnableMatch = rest.match(/^\/actions\/workflows\/([^/]+)\/enable$/);
  if (workflowEnableMatch) {
    if (method !== 'PUT') { return jsonMethodNotAllowed(`${method} not allowed on /actions/workflows/:workflow_id/enable.`); }
    return handleEnableWorkflow(ctx, targetDid, repoName, workflowEnableMatch[1]);
  }

  // GET /repos/:did/:repo/actions/workflows/:workflow_id
  const workflowMatch = rest.match(/^\/actions\/workflows\/([^/]+)$/);
  if (workflowMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/workflows/:workflow_id.`); }
    return handleGetWorkflow(ctx, targetDid, repoName, workflowMatch[1], url);
  }

  // GET /repos/:did/:repo/actions/runs
  if (rest === '/actions/runs') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs.`); }
    return handleListWorkflowRuns(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/actions/runs/:run_id/attempts/:attempt_number/logs
  const workflowRunAttemptLogsMatch = rest.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/logs$/);
  if (workflowRunAttemptLogsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/attempts/:attempt_number/logs.`); }
    return handleDownloadWorkflowRunAttemptLogs(
      ctx, targetDid, repoName, workflowRunAttemptLogsMatch[1], workflowRunAttemptLogsMatch[2], url,
    );
  }

  // GET /repos/:did/:repo/actions/runs/:run_id/attempts/:attempt_number
  const workflowRunAttemptMatch = rest.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/);
  if (workflowRunAttemptMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/attempts/:attempt_number.`); }
    return handleGetWorkflowRunAttempt(ctx, targetDid, repoName, workflowRunAttemptMatch[1], workflowRunAttemptMatch[2], url);
  }

  // GET/DELETE /repos/:did/:repo/actions/runs/:run_id/logs
  const workflowRunLogsMatch = rest.match(/^\/actions\/runs\/(\d+)\/logs$/);
  if (workflowRunLogsMatch) {
    if (method === 'GET') { return handleDownloadWorkflowRunLogs(ctx, targetDid, repoName, workflowRunLogsMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteWorkflowRunLogs(ctx, targetDid, repoName, workflowRunLogsMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/logs.`);
  }

  // GET /repos/:did/:repo/actions/runs/:run_id/timing
  const workflowRunTimingMatch = rest.match(/^\/actions\/runs\/(\d+)\/timing$/);
  if (workflowRunTimingMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/timing.`); }
    return handleGetWorkflowRunUsage(ctx, targetDid, repoName, workflowRunTimingMatch[1]);
  }

  // GET /repos/:did/:repo/actions/runs/:run_id/artifacts
  const workflowRunArtifactsMatch = rest.match(/^\/actions\/runs\/(\d+)\/artifacts$/);
  if (workflowRunArtifactsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/artifacts.`); }
    return handleListWorkflowRunArtifacts(ctx, targetDid, repoName, workflowRunArtifactsMatch[1], url);
  }

  // GET /repos/:did/:repo/actions/runs/:run_id/jobs
  const workflowRunJobsMatch = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/);
  if (workflowRunJobsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/jobs.`); }
    return handleListWorkflowRunJobs(ctx, targetDid, repoName, workflowRunJobsMatch[1], url);
  }

  // POST /repos/:did/:repo/actions/runs/:run_id/rerun-failed-jobs
  const workflowRunFailedRerunMatch = rest.match(/^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/);
  if (workflowRunFailedRerunMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/rerun-failed-jobs.`); }
    return handleRerunFailedWorkflowJobs(ctx, targetDid, repoName, workflowRunFailedRerunMatch[1]);
  }

  // POST /repos/:did/:repo/actions/runs/:run_id/rerun
  const workflowRunRerunMatch = rest.match(/^\/actions\/runs\/(\d+)\/rerun$/);
  if (workflowRunRerunMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/rerun.`); }
    return handleRerunWorkflowRun(ctx, targetDid, repoName, workflowRunRerunMatch[1]);
  }

  // POST /repos/:did/:repo/actions/runs/:run_id/cancel
  const workflowRunCancelMatch = rest.match(/^\/actions\/runs\/(\d+)\/cancel$/);
  if (workflowRunCancelMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/cancel.`); }
    return handleCancelWorkflowRun(ctx, targetDid, repoName, workflowRunCancelMatch[1]);
  }

  // POST /repos/:did/:repo/actions/runs/:run_id/force-cancel
  const workflowRunForceCancelMatch = rest.match(/^\/actions\/runs\/(\d+)\/force-cancel$/);
  if (workflowRunForceCancelMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id/force-cancel.`); }
    return handleForceCancelWorkflowRun(ctx, targetDid, repoName, workflowRunForceCancelMatch[1]);
  }

  // GET/DELETE /repos/:did/:repo/actions/runs/:run_id
  const workflowRunMatch = rest.match(/^\/actions\/runs\/(\d+)$/);
  if (workflowRunMatch) {
    if (method === 'GET') { return handleGetWorkflowRun(ctx, targetDid, repoName, workflowRunMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteWorkflowRun(ctx, targetDid, repoName, workflowRunMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /actions/runs/:run_id.`);
  }

  // GET /repos/:did/:repo/actions/jobs/:job_id/logs
  const workflowJobLogsMatch = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/);
  if (workflowJobLogsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/jobs/:job_id/logs.`); }
    return handleDownloadWorkflowJobLogs(ctx, targetDid, repoName, workflowJobLogsMatch[1], url);
  }

  // POST /repos/:did/:repo/actions/jobs/:job_id/rerun
  const workflowJobRerunMatch = rest.match(/^\/actions\/jobs\/(\d+)\/rerun$/);
  if (workflowJobRerunMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /actions/jobs/:job_id/rerun.`); }
    return handleRerunWorkflowJob(ctx, targetDid, repoName, workflowJobRerunMatch[1]);
  }

  // GET /repos/:did/:repo/actions/jobs/:job_id
  const workflowJobMatch = rest.match(/^\/actions\/jobs\/(\d+)$/);
  if (workflowJobMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /actions/jobs/:job_id.`); }
    return handleGetWorkflowJob(ctx, targetDid, repoName, workflowJobMatch[1], url);
  }

  // GET /repos/:did/:repo/stargazers
  if (rest === '/stargazers') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /stargazers.`); }
    return handleListStargazers(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/subscribers
  if (rest === '/subscribers') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /subscribers.`); }
    return handleListSubscribers(ctx, targetDid, repoName, url);
  }

  // /repos/:did/:repo/subscription
  if (rest === '/subscription') {
    if (method === 'GET') { return handleGetRepoSubscription(ctx, targetDid, repoName, url); }
    if (method === 'PUT') { return handleSetRepoSubscription(ctx, targetDid, repoName, reqBody, url); }
    if (method === 'DELETE') { return handleDeleteRepoSubscription(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /subscription.`);
  }

  // /repos/:did/:repo/hooks
  if (rest === '/hooks') {
    if (method === 'GET') { return handleListRepoWebhooks(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateRepoWebhook(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks.`);
  }

  // /repos/:did/:repo/hooks/:hook_id/config
  const webhookConfigMatch = rest.match(/^\/hooks\/(\d+)\/config$/);
  if (webhookConfigMatch) {
    if (method === 'GET') { return handleGetRepoWebhookConfig(ctx, targetDid, repoName, webhookConfigMatch[1]); }
    if (method === 'PATCH') { return handleUpdateRepoWebhookConfig(ctx, targetDid, repoName, webhookConfigMatch[1], reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks/:hook_id/config.`);
  }

  // POST /repos/:did/:repo/hooks/:hook_id/deliveries/:delivery_id/attempts
  const webhookDeliveryAttemptsMatch = rest.match(/^\/hooks\/(\d+)\/deliveries\/(\d+)\/attempts$/);
  if (webhookDeliveryAttemptsMatch) {
    if (method === 'POST') {
      return handleRedeliverRepoWebhookDelivery(
        ctx,
        targetDid,
        repoName,
        webhookDeliveryAttemptsMatch[1],
        webhookDeliveryAttemptsMatch[2],
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks/:hook_id/deliveries/:delivery_id/attempts.`);
  }

  // GET /repos/:did/:repo/hooks/:hook_id/deliveries/:delivery_id
  const webhookDeliveryMatch = rest.match(/^\/hooks\/(\d+)\/deliveries\/(\d+)$/);
  if (webhookDeliveryMatch) {
    if (method === 'GET') {
      return handleGetRepoWebhookDelivery(ctx, targetDid, repoName, webhookDeliveryMatch[1], webhookDeliveryMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks/:hook_id/deliveries/:delivery_id.`);
  }

  // GET /repos/:did/:repo/hooks/:hook_id/deliveries
  const webhookDeliveriesMatch = rest.match(/^\/hooks\/(\d+)\/deliveries$/);
  if (webhookDeliveriesMatch) {
    if (method === 'GET') {
      return handleListRepoWebhookDeliveries(ctx, targetDid, repoName, webhookDeliveriesMatch[1], url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks/:hook_id/deliveries.`);
  }

  // POST /repos/:did/:repo/hooks/:hook_id/pings
  const webhookPingMatch = rest.match(/^\/hooks\/(\d+)\/pings$/);
  if (webhookPingMatch) {
    if (method === 'POST') { return handlePingRepoWebhook(ctx, targetDid, repoName, webhookPingMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks/:hook_id/pings.`);
  }

  // POST /repos/:did/:repo/hooks/:hook_id/tests (and legacy /test)
  const webhookTestMatch = rest.match(/^\/hooks\/(\d+)\/tests?$/);
  if (webhookTestMatch) {
    if (method === 'POST') { return handleTestRepoWebhook(ctx, targetDid, repoName, webhookTestMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks/:hook_id/tests.`);
  }

  // /repos/:did/:repo/hooks/:hook_id
  const webhookMatch = rest.match(/^\/hooks\/(\d+)$/);
  if (webhookMatch) {
    if (method === 'GET') { return handleGetRepoWebhook(ctx, targetDid, repoName, webhookMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateRepoWebhook(ctx, targetDid, repoName, webhookMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteRepoWebhook(ctx, targetDid, repoName, webhookMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /hooks/:hook_id.`);
  }

  // /repos/:did/:repo/notifications
  if (rest === '/notifications') {
    if (method === 'GET') { return handleListRepoNotifications(ctx, targetDid, repoName, url); }
    if (method === 'PUT') { return handleMarkRepoNotificationsRead(ctx, targetDid, repoName, reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /notifications.`);
  }

  // GET/POST /repos/:did/:repo/labels
  if (rest === '/labels') {
    if (method === 'GET') { return handleListRepoLabels(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateRepoLabel(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /labels.`);
  }

  // GET/PATCH/DELETE /repos/:did/:repo/labels/:name
  const repoLabelMatch = rest.match(/^\/labels\/(.+)$/);
  if (repoLabelMatch) {
    if (method === 'GET') { return handleGetRepoLabel(ctx, targetDid, repoName, repoLabelMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateRepoLabel(ctx, targetDid, repoName, repoLabelMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteRepoLabel(ctx, targetDid, repoName, repoLabelMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /labels/:name.`);
  }

  // GET/POST /repos/:did/:repo/milestones
  if (rest === '/milestones') {
    if (method === 'GET') { return handleListMilestones(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateMilestone(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /milestones.`);
  }

  // GET /repos/:did/:repo/milestones/:number/labels
  const milestoneLabelsMatch = rest.match(/^\/milestones\/(\d+)\/labels$/);
  if (milestoneLabelsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /milestones/:number/labels.`); }
    return handleListMilestoneLabels(ctx, targetDid, repoName, milestoneLabelsMatch[1], url);
  }

  // GET/PATCH/DELETE /repos/:did/:repo/milestones/:number
  const milestoneMatch = rest.match(/^\/milestones\/(\d+)$/);
  if (milestoneMatch) {
    if (method === 'GET') { return handleGetMilestone(ctx, targetDid, repoName, milestoneMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateMilestone(ctx, targetDid, repoName, milestoneMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteMilestone(ctx, targetDid, repoName, milestoneMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /milestones/:number.`);
  }

  // /repos/:did/:repo/issues[/...]
  if (rest === '/issues') {
    const bodyMediaKind = githubBodyMediaKind(options.accept);
    if (method === 'POST') { return handleCreateIssue(ctx, targetDid, repoName, reqBody, url, bodyMediaKind); }
    if (method === 'GET') { return handleListIssues(ctx, targetDid, repoName, url, bodyMediaKind); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues.`);
  }

  // /repos/:did/:repo/pulls[/...]
  if (rest === '/pulls') {
    const bodyMediaKind = githubBodyMediaKind(options.accept);
    if (method === 'POST') { return handleCreatePull(ctx, targetDid, repoName, reqBody, url, bodyMediaKind); }
    if (method === 'GET') { return handleListPulls(ctx, targetDid, repoName, url, bodyMediaKind); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls.`);
  }

  // /repos/:did/:repo/releases
  if (rest === '/releases') {
    if (method === 'POST') { return handleCreateRelease(ctx, targetDid, repoName, reqBody, url); }
    if (method === 'GET') { return handleListReleases(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /releases.`);
  }

  // POST /repos/:did/:repo/releases/generate-notes
  if (rest === '/releases/generate-notes') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /releases/generate-notes.`); }
    return handleGenerateReleaseNotes(ctx, targetDid, repoName, reqBody);
  }

  // GET /repos/:did/:repo/releases/latest
  if (rest === '/releases/latest') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /releases/latest.`); }
    return handleGetLatestRelease(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/releases/assets/:id/download
  const releaseAssetDownloadMatch = rest.match(/^\/releases\/assets\/(\d+)\/download$/);
  if (releaseAssetDownloadMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /releases/assets/:id/download.`); }
    return handleDownloadReleaseAsset(ctx, targetDid, repoName, releaseAssetDownloadMatch[1], url);
  }

  // /repos/:did/:repo/releases/assets/:id
  const releaseAssetMatch = rest.match(/^\/releases\/assets\/(\d+)$/);
  if (releaseAssetMatch) {
    if (method === 'GET') {
      return handleGetReleaseAsset(
        ctx, targetDid, repoName, releaseAssetMatch[1], url, githubReleaseAssetMediaKind(options.accept),
      );
    }
    if (method === 'PATCH') { return handleUpdateReleaseAsset(ctx, targetDid, repoName, releaseAssetMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteReleaseAsset(ctx, targetDid, repoName, releaseAssetMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /releases/assets/:id.`);
  }

  // GET /repos/:did/:repo/releases/download/:tag/:asset
  const releaseAssetByNameMatch = rest.match(/^\/releases\/download\/([^/]+)\/(.+)$/);
  if (releaseAssetByNameMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /releases/download/:tag/:asset.`); }
    return handleDownloadReleaseAssetByName(ctx, targetDid, repoName, releaseAssetByNameMatch[1], releaseAssetByNameMatch[2]);
  }

  // GET/POST /repos/:did/:repo/releases/:id/assets
  const releaseAssetsMatch = rest.match(/^\/releases\/(\d+)\/assets$/);
  if (releaseAssetsMatch) {
    if (method === 'GET') { return handleListReleaseAssets(ctx, targetDid, repoName, releaseAssetsMatch[1], url); }
    if (method === 'POST') { return handleUploadReleaseAsset(ctx, targetDid, repoName, releaseAssetsMatch[1], url, options); }
    return jsonMethodNotAllowed(`${method} not allowed on /releases/:id/assets.`);
  }

  // /repos/:did/:repo/releases/:id/reactions
  const releaseReactionsMatch = rest.match(/^\/releases\/(\d+)\/reactions$/);
  if (releaseReactionsMatch) {
    if (method === 'GET') { return handleListReleaseReactions(ctx, targetDid, repoName, releaseReactionsMatch[1], url); }
    if (method === 'POST') {
      return handleCreateReleaseReaction(ctx, targetDid, repoName, releaseReactionsMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /releases/:id/reactions.`);
  }

  // DELETE /repos/:did/:repo/releases/:id/reactions/:reaction_id
  const releaseReactionMatch = rest.match(/^\/releases\/(\d+)\/reactions\/(\d+)$/);
  if (releaseReactionMatch) {
    if (method === 'DELETE') {
      return handleDeleteReleaseReaction(ctx, targetDid, repoName, releaseReactionMatch[1], releaseReactionMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /releases/:id/reactions/:reaction_id.`);
  }

  // /repos/:did/:repo/releases/:id
  const releaseIdMatch = rest.match(/^\/releases\/(\d+)$/);
  if (releaseIdMatch) {
    if (method === 'GET') { return handleGetReleaseById(ctx, targetDid, repoName, releaseIdMatch[1], url); }
    if (method === 'PATCH') { return handleUpdateRelease(ctx, targetDid, repoName, releaseIdMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteRelease(ctx, targetDid, repoName, releaseIdMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /releases/:id.`);
  }

  // GET /repos/:did/:repo/releases/tags/:tag
  const releaseTagMatch = rest.match(/^\/releases\/tags\/(.+)$/);
  if (releaseTagMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /releases/tags/:tag.`); }
    return handleGetReleaseByTag(ctx, targetDid, repoName, releaseTagMatch[1], url);
  }

  // /repos/:did/:repo/environments
  if (rest === '/environments') {
    if (method === 'GET') { return handleListEnvironments(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /environments.`);
  }

  // GET /repos/:did/:repo/environments/:environment_name/secrets/public-key
  const environmentSecretsPublicKeyMatch = rest.match(/^\/environments\/([^/]+)\/secrets\/public-key$/);
  if (environmentSecretsPublicKeyMatch) {
    if (method === 'GET') {
      return handleGetEnvironmentSecretsPublicKey(ctx, targetDid, repoName, environmentSecretsPublicKeyMatch[1]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /environments/:environment_name/secrets/public-key.`);
  }

  // GET /repos/:did/:repo/environments/:environment_name/secrets
  const environmentSecretsMatch = rest.match(/^\/environments\/([^/]+)\/secrets$/);
  if (environmentSecretsMatch) {
    if (method === 'GET') {
      return handleListEnvironmentSecrets(ctx, targetDid, repoName, environmentSecretsMatch[1], url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /environments/:environment_name/secrets.`);
  }

  // GET/PUT/DELETE /repos/:did/:repo/environments/:environment_name/secrets/:secret_name
  const environmentSecretMatch = rest.match(/^\/environments\/([^/]+)\/secrets\/([^/]+)$/);
  if (environmentSecretMatch) {
    if (method === 'GET') {
      return handleGetEnvironmentSecret(ctx, targetDid, repoName, environmentSecretMatch[1], environmentSecretMatch[2]);
    }
    if (method === 'PUT') {
      return handleCreateOrUpdateEnvironmentSecret(
        ctx, targetDid, repoName, environmentSecretMatch[1], environmentSecretMatch[2], reqBody,
      );
    }
    if (method === 'DELETE') {
      return handleDeleteEnvironmentSecret(ctx, targetDid, repoName, environmentSecretMatch[1], environmentSecretMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /environments/:environment_name/secrets/:secret_name.`);
  }

  // GET/POST /repos/:did/:repo/environments/:environment_name/variables
  const environmentVariablesMatch = rest.match(/^\/environments\/([^/]+)\/variables$/);
  if (environmentVariablesMatch) {
    if (method === 'GET') {
      return handleListEnvironmentVariables(ctx, targetDid, repoName, environmentVariablesMatch[1], url);
    }
    if (method === 'POST') {
      return handleCreateEnvironmentVariable(ctx, targetDid, repoName, environmentVariablesMatch[1], reqBody);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /environments/:environment_name/variables.`);
  }

  // GET/PATCH/DELETE /repos/:did/:repo/environments/:environment_name/variables/:name
  const environmentVariableMatch = rest.match(/^\/environments\/([^/]+)\/variables\/([^/]+)$/);
  if (environmentVariableMatch) {
    if (method === 'GET') {
      return handleGetEnvironmentVariable(ctx, targetDid, repoName, environmentVariableMatch[1], environmentVariableMatch[2]);
    }
    if (method === 'PATCH') {
      return handleUpdateEnvironmentVariable(
        ctx, targetDid, repoName, environmentVariableMatch[1], environmentVariableMatch[2], reqBody,
      );
    }
    if (method === 'DELETE') {
      return handleDeleteEnvironmentVariable(
        ctx, targetDid, repoName, environmentVariableMatch[1], environmentVariableMatch[2],
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /environments/:environment_name/variables/:name.`);
  }

  // /repos/:did/:repo/environments/:environment_name
  const environmentMatch = rest.match(/^\/environments\/([^/]+)$/);
  if (environmentMatch) {
    if (method === 'GET') { return handleGetEnvironment(ctx, targetDid, repoName, environmentMatch[1], url); }
    if (method === 'PUT') { return handleCreateOrUpdateEnvironment(ctx, targetDid, repoName, environmentMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleDeleteEnvironment(ctx, targetDid, repoName, environmentMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /environments/:environment_name.`);
  }

  // /repos/:did/:repo/deployments
  if (rest === '/deployments') {
    if (method === 'GET') { return handleListDeployments(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreateDeployment(ctx, targetDid, repoName, reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /deployments.`);
  }

  // /repos/:did/:repo/deployments/:id/statuses
  const deploymentStatusesMatch = rest.match(/^\/deployments\/(\d+)\/statuses$/);
  if (deploymentStatusesMatch) {
    if (method === 'GET') { return handleListDeploymentStatuses(ctx, targetDid, repoName, deploymentStatusesMatch[1], url); }
    if (method === 'POST') { return handleCreateDeploymentStatus(ctx, targetDid, repoName, deploymentStatusesMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /deployments/:id/statuses.`);
  }

  // GET /repos/:did/:repo/deployments/:id/statuses/:status_id
  const deploymentStatusMatch = rest.match(/^\/deployments\/(\d+)\/statuses\/(\d+)$/);
  if (deploymentStatusMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /deployments/:id/statuses/:status_id.`); }
    return handleGetDeploymentStatus(ctx, targetDid, repoName, deploymentStatusMatch[1], deploymentStatusMatch[2], url);
  }

  // /repos/:did/:repo/deployments/:id
  const deploymentMatch = rest.match(/^\/deployments\/(\d+)$/);
  if (deploymentMatch) {
    if (method === 'GET') { return handleGetDeployment(ctx, targetDid, repoName, deploymentMatch[1], url); }
    if (method === 'DELETE') { return handleDeleteDeployment(ctx, targetDid, repoName, deploymentMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /deployments/:id.`);
  }

  // GET /repos/:did/:repo/pages/builds/latest
  if (rest === '/pages/builds/latest') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pages/builds/latest.`); }
    return handleGetLatestPagesBuild(ctx, targetDid, repoName, url);
  }

  // GET/POST /repos/:did/:repo/pages/builds
  if (rest === '/pages/builds') {
    if (method === 'GET') { return handleListPagesBuilds(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleRequestPagesBuild(ctx, targetDid, repoName, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /pages/builds.`);
  }

  // GET /repos/:did/:repo/pages/builds/:build_id
  const pagesBuildMatch = rest.match(/^\/pages\/builds\/(\d+)$/);
  if (pagesBuildMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pages/builds/:build_id.`); }
    return handleGetPagesBuild(ctx, targetDid, repoName, pagesBuildMatch[1], url);
  }

  // POST /repos/:did/:repo/pages/deployments/:pages_deployment_id/cancel
  const pagesDeploymentCancelMatch = rest.match(/^\/pages\/deployments\/([^/]+)\/cancel$/);
  if (pagesDeploymentCancelMatch) {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /pages/deployments/:pages_deployment_id/cancel.`); }
    return handleCancelPagesDeployment(ctx, targetDid, repoName, pagesDeploymentCancelMatch[1]);
  }

  // GET /repos/:did/:repo/pages/deployments/:pages_deployment_id/status
  const pagesDeploymentStatusMatch = rest.match(/^\/pages\/deployments\/([^/]+)\/status$/);
  if (pagesDeploymentStatusMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pages/deployments/:pages_deployment_id/status.`); }
    return handleGetPagesDeploymentStatus(ctx, targetDid, repoName, pagesDeploymentStatusMatch[1]);
  }

  // GET /repos/:did/:repo/pages/deployments/:pages_deployment_id
  const pagesDeploymentMatch = rest.match(/^\/pages\/deployments\/([^/]+)$/);
  if (pagesDeploymentMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pages/deployments/:pages_deployment_id.`); }
    return handleGetPagesDeploymentStatus(ctx, targetDid, repoName, pagesDeploymentMatch[1]);
  }

  // POST /repos/:did/:repo/pages/deployments
  if (rest === '/pages/deployments') {
    if (method !== 'POST') { return jsonMethodNotAllowed(`${method} not allowed on /pages/deployments.`); }
    return handleCreatePagesDeployment(ctx, targetDid, repoName, reqBody, url);
  }

  // GET /repos/:did/:repo/pages/health
  if (rest === '/pages/health') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pages/health.`); }
    return handleGetPagesHealth(ctx, targetDid, repoName);
  }

  // GET/POST/PUT/DELETE /repos/:did/:repo/pages
  if (rest === '/pages') {
    if (method === 'GET') { return handleGetPagesSite(ctx, targetDid, repoName, url); }
    if (method === 'POST') { return handleCreatePagesSite(ctx, targetDid, repoName, reqBody, url); }
    if (method === 'PUT') { return handleUpdatePagesSite(ctx, targetDid, repoName, reqBody); }
    if (method === 'DELETE') { return handleDeletePagesSite(ctx, targetDid, repoName); }
    return jsonMethodNotAllowed(`${method} not allowed on /pages.`);
  }

  // GET /repos/:did/:repo/comments
  if (rest === '/comments') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /comments.`); }
    return handleListCommitComments(ctx, targetDid, repoName, url, githubCommitCommentBodyMediaKind(options.accept));
  }

  // /repos/:did/:repo/comments/:id/reactions
  const commitCommentReactionsMatch = rest.match(/^\/comments\/(\d+)\/reactions$/);
  if (commitCommentReactionsMatch) {
    if (method === 'GET') {
      return handleListCommitCommentReactions(ctx, targetDid, repoName, commitCommentReactionsMatch[1], url);
    }
    if (method === 'POST') {
      return handleCreateCommitCommentReaction(ctx, targetDid, repoName, commitCommentReactionsMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /comments/:id/reactions.`);
  }

  // DELETE /repos/:did/:repo/comments/:id/reactions/:reaction_id
  const commitCommentReactionMatch = rest.match(/^\/comments\/(\d+)\/reactions\/(\d+)$/);
  if (commitCommentReactionMatch) {
    if (method === 'DELETE') {
      return handleDeleteCommitCommentReaction(ctx, targetDid, repoName, commitCommentReactionMatch[1], commitCommentReactionMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /comments/:id/reactions/:reaction_id.`);
  }

  // /repos/:did/:repo/comments/:id
  const commitCommentMatch = rest.match(/^\/comments\/(\d+)$/);
  if (commitCommentMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'GET') { return handleGetCommitComment(ctx, targetDid, repoName, commitCommentMatch[1], url, bodyMediaKind); }
    if (method === 'PATCH') {
      return handleUpdateCommitComment(ctx, targetDid, repoName, commitCommentMatch[1], reqBody, url, bodyMediaKind);
    }
    if (method === 'DELETE') { return handleDeleteCommitComment(ctx, targetDid, repoName, commitCommentMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /comments/:id.`);
  }

  // GET /repos/:did/:repo/issues/comments
  if (rest === '/issues/comments') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /issues/comments.`); }
    return handleListRepoIssueComments(ctx, targetDid, repoName, url, githubBodyMediaKind(options.accept));
  }

  // GET /repos/:did/:repo/issues/events
  if (rest === '/issues/events') {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /issues/events.`); }
    return handleListRepoIssueEvents(ctx, targetDid, repoName, url);
  }

  // GET /repos/:did/:repo/issues/events/:id
  const issueEventMatch = rest.match(/^\/issues\/events\/(\d+)$/);
  if (issueEventMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /issues/events/:id.`); }
    return handleGetIssueEvent(ctx, targetDid, repoName, issueEventMatch[1], url);
  }

  // PUT/DELETE /repos/:did/:repo/issues/comments/:id/pin
  const issueCommentPinMatch = rest.match(/^\/issues\/comments\/(\d+)\/pin$/);
  if (issueCommentPinMatch) {
    if (method === 'PUT') {
      return handlePinIssueComment(
        ctx, targetDid, repoName, issueCommentPinMatch[1], url, githubBodyMediaKind(options.accept),
      );
    }
    if (method === 'DELETE') { return handleUnpinIssueComment(ctx, targetDid, repoName, issueCommentPinMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/comments/:id/pin.`);
  }

  // /repos/:did/:repo/issues/comments/:id/reactions
  const issueCommentReactionsMatch = rest.match(/^\/issues\/comments\/(\d+)\/reactions$/);
  if (issueCommentReactionsMatch) {
    if (method === 'GET') { return handleListIssueCommentReactions(ctx, targetDid, repoName, issueCommentReactionsMatch[1], url); }
    if (method === 'POST') { return handleCreateIssueCommentReaction(ctx, targetDid, repoName, issueCommentReactionsMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/comments/:id/reactions.`);
  }

  // DELETE /repos/:did/:repo/issues/comments/:id/reactions/:reaction_id
  const issueCommentReactionMatch = rest.match(/^\/issues\/comments\/(\d+)\/reactions\/(\d+)$/);
  if (issueCommentReactionMatch) {
    if (method === 'DELETE') {
      return handleDeleteIssueCommentReaction(ctx, targetDid, repoName, issueCommentReactionMatch[1], issueCommentReactionMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/comments/:id/reactions/:reaction_id.`);
  }

  // /repos/:did/:repo/issues/comments/:id
  const issueCommentMatch = rest.match(/^\/issues\/comments\/(\d+)$/);
  if (issueCommentMatch) {
    const bodyMediaKind = githubBodyMediaKind(options.accept);
    if (method === 'GET') { return handleGetIssueComment(ctx, targetDid, repoName, issueCommentMatch[1], url, bodyMediaKind); }
    if (method === 'PATCH') {
      return handleUpdateIssueComment(ctx, targetDid, repoName, issueCommentMatch[1], reqBody, url, bodyMediaKind);
    }
    if (method === 'DELETE') { return handleDeleteIssueComment(ctx, targetDid, repoName, issueCommentMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/comments/:id.`);
  }

  // /repos/:did/:repo/issues/:number/comments
  const issueCommentsMatch = rest.match(/^\/issues\/(\d+)\/comments$/);
  if (issueCommentsMatch) {
    const bodyMediaKind = githubBodyMediaKind(options.accept);
    if (method === 'POST') {
      return handleCreateIssueComment(ctx, targetDid, repoName, issueCommentsMatch[1], reqBody, url, bodyMediaKind);
    }
    if (method === 'GET') {
      return handleListIssueComments(ctx, targetDid, repoName, issueCommentsMatch[1], url, bodyMediaKind);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/comments.`);
  }

  // GET /repos/:did/:repo/issues/:number/events
  const issueEventsMatch = rest.match(/^\/issues\/(\d+)\/events$/);
  if (issueEventsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/events.`); }
    return handleListIssueEvents(ctx, targetDid, repoName, issueEventsMatch[1], url);
  }

  // GET /repos/:did/:repo/issues/:number/timeline
  const issueTimelineMatch = rest.match(/^\/issues\/(\d+)\/timeline$/);
  if (issueTimelineMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/timeline.`); }
    return handleListIssueTimeline(ctx, targetDid, repoName, issueTimelineMatch[1], url);
  }

  // /repos/:did/:repo/issues/:number/reactions
  const issueReactionsMatch = rest.match(/^\/issues\/(\d+)\/reactions$/);
  if (issueReactionsMatch) {
    if (method === 'GET') { return handleListIssueReactions(ctx, targetDid, repoName, issueReactionsMatch[1], url); }
    if (method === 'POST') { return handleCreateIssueReaction(ctx, targetDid, repoName, issueReactionsMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/reactions.`);
  }

  // DELETE /repos/:did/:repo/issues/:number/reactions/:reaction_id
  const issueReactionMatch = rest.match(/^\/issues\/(\d+)\/reactions\/(\d+)$/);
  if (issueReactionMatch) {
    if (method === 'DELETE') {
      return handleDeleteIssueReaction(ctx, targetDid, repoName, issueReactionMatch[1], issueReactionMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/reactions/:reaction_id.`);
  }

  // PUT/DELETE /repos/:did/:repo/issues/:number/lock
  const issueLockMatch = rest.match(/^\/issues\/(\d+)\/lock$/);
  if (issueLockMatch) {
    if (method === 'PUT') { return handleLockIssue(ctx, targetDid, repoName, issueLockMatch[1], reqBody); }
    if (method === 'DELETE') { return handleUnlockIssue(ctx, targetDid, repoName, issueLockMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/lock.`);
  }

  // GET /repos/:did/:repo/issues/:number/assignees/:did
  const issueAssigneeCheckMatch = rest.match(/^\/issues\/(\d+)\/assignees\/(.+)$/);
  if (issueAssigneeCheckMatch) {
    if (method === 'GET') {
      return handleCheckIssueAssignee(ctx, targetDid, repoName, issueAssigneeCheckMatch[1], issueAssigneeCheckMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/assignees/:did.`);
  }

  // /repos/:did/:repo/issues/:number/assignees
  const issueAssigneesMatch = rest.match(/^\/issues\/(\d+)\/assignees$/);
  if (issueAssigneesMatch) {
    if (method === 'POST') { return handleAddIssueAssignees(ctx, targetDid, repoName, issueAssigneesMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleRemoveIssueAssignees(ctx, targetDid, repoName, issueAssigneesMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/assignees.`);
  }

  // /repos/:did/:repo/issues/:number/dependencies/blocked_by
  const issueDependenciesBlockedByMatch = rest.match(/^\/issues\/(\d+)\/dependencies\/blocked_by$/);
  if (issueDependenciesBlockedByMatch) {
    if (method === 'GET') {
      return handleListIssueDependenciesBlockedBy(ctx, targetDid, repoName, issueDependenciesBlockedByMatch[1], url);
    }
    if (method === 'POST') {
      return handleAddIssueDependencyBlockedBy(ctx, targetDid, repoName, issueDependenciesBlockedByMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/dependencies/blocked_by.`);
  }

  // DELETE /repos/:did/:repo/issues/:number/dependencies/blocked_by/:issue_id
  const issueDependencyBlockedByMatch = rest.match(/^\/issues\/(\d+)\/dependencies\/blocked_by\/(\d+)$/);
  if (issueDependencyBlockedByMatch) {
    if (method === 'DELETE') {
      return handleRemoveIssueDependencyBlockedBy(
        ctx, targetDid, repoName, issueDependencyBlockedByMatch[1], issueDependencyBlockedByMatch[2], url,
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/dependencies/blocked_by/:issue_id.`);
  }

  // GET /repos/:did/:repo/issues/:number/dependencies/blocking
  const issueDependenciesBlockingMatch = rest.match(/^\/issues\/(\d+)\/dependencies\/blocking$/);
  if (issueDependenciesBlockingMatch) {
    if (method === 'GET') {
      return handleListIssueDependenciesBlocking(ctx, targetDid, repoName, issueDependenciesBlockingMatch[1], url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/dependencies/blocking.`);
  }

  // GET /repos/:did/:repo/issues/:number/parent
  const issueParentMatch = rest.match(/^\/issues\/(\d+)\/parent$/);
  if (issueParentMatch) {
    if (method === 'GET') { return handleGetIssueParent(ctx, targetDid, repoName, issueParentMatch[1], url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/parent.`);
  }

  // PATCH /repos/:did/:repo/issues/:number/sub_issues/priority
  const issueSubIssuesPriorityMatch = rest.match(/^\/issues\/(\d+)\/sub_issues\/priority$/);
  if (issueSubIssuesPriorityMatch) {
    if (method === 'PATCH') {
      return handleReprioritizeIssueSubIssue(ctx, targetDid, repoName, issueSubIssuesPriorityMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/sub_issues/priority.`);
  }

  // GET/POST /repos/:did/:repo/issues/:number/sub_issues
  const issueSubIssuesMatch = rest.match(/^\/issues\/(\d+)\/sub_issues$/);
  if (issueSubIssuesMatch) {
    if (method === 'GET') { return handleListIssueSubIssues(ctx, targetDid, repoName, issueSubIssuesMatch[1], url); }
    if (method === 'POST') { return handleAddIssueSubIssue(ctx, targetDid, repoName, issueSubIssuesMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/sub_issues.`);
  }

  // DELETE /repos/:did/:repo/issues/:number/sub_issue
  const issueSubIssueMatch = rest.match(/^\/issues\/(\d+)\/sub_issue$/);
  if (issueSubIssueMatch) {
    if (method === 'DELETE') { return handleRemoveIssueSubIssue(ctx, targetDid, repoName, issueSubIssueMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/sub_issue.`);
  }

  // GET/POST/PUT /repos/:did/:repo/issues/:number/issue-field-values
  const issueFieldValuesMatch = rest.match(/^\/issues\/(\d+)\/issue-field-values$/);
  if (issueFieldValuesMatch) {
    if (method === 'GET') { return handleListIssueFieldValues(ctx, targetDid, repoName, issueFieldValuesMatch[1], url); }
    if (method === 'POST') { return handleAddIssueFieldValues(ctx, targetDid, repoName, issueFieldValuesMatch[1], reqBody); }
    if (method === 'PUT') { return handleSetIssueFieldValues(ctx, targetDid, repoName, issueFieldValuesMatch[1], reqBody); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/issue-field-values.`);
  }

  // DELETE /repos/:did/:repo/issues/:number/issue-field-values/:issue_field_id
  const issueFieldValueMatch = rest.match(/^\/issues\/(\d+)\/issue-field-values\/(\d+)$/);
  if (issueFieldValueMatch) {
    if (method === 'DELETE') {
      return handleDeleteIssueFieldValue(ctx, targetDid, repoName, issueFieldValueMatch[1], issueFieldValueMatch[2]);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/issue-field-values/:issue_field_id.`);
  }

  // /repos/:did/:repo/issues/:number/labels
  const issueLabelsMatch = rest.match(/^\/issues\/(\d+)\/labels$/);
  if (issueLabelsMatch) {
    if (method === 'GET') { return handleListIssueLabels(ctx, targetDid, repoName, issueLabelsMatch[1], url); }
    if (method === 'POST') { return handleAddIssueLabels(ctx, targetDid, repoName, issueLabelsMatch[1], reqBody, url); }
    if (method === 'PUT') { return handleReplaceIssueLabels(ctx, targetDid, repoName, issueLabelsMatch[1], reqBody, url); }
    if (method === 'DELETE') { return handleRemoveAllIssueLabels(ctx, targetDid, repoName, issueLabelsMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/labels.`);
  }

  // DELETE /repos/:did/:repo/issues/:number/labels/:name
  const issueLabelMatch = rest.match(/^\/issues\/(\d+)\/labels\/(.+)$/);
  if (issueLabelMatch) {
    if (method === 'DELETE') {
      return handleRemoveIssueLabel(ctx, targetDid, repoName, issueLabelMatch[1], issueLabelMatch[2], url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number/labels/:name.`);
  }

  // /repos/:did/:repo/pulls/comments
  if (rest === '/pulls/comments') {
    if (method === 'GET') {
      return handleListRepoPullReviewComments(
        ctx, targetDid, repoName, url, githubCommitCommentBodyMediaKind(options.accept),
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/comments.`);
  }

  // /repos/:did/:repo/pulls/comments/:id/reactions
  const pullReviewCommentReactionsMatch = rest.match(/^\/pulls\/comments\/(\d+)\/reactions$/);
  if (pullReviewCommentReactionsMatch) {
    if (method === 'GET') {
      return handleListPullReviewCommentReactions(ctx, targetDid, repoName, pullReviewCommentReactionsMatch[1], url);
    }
    if (method === 'POST') {
      return handleCreatePullReviewCommentReaction(ctx, targetDid, repoName, pullReviewCommentReactionsMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/comments/:id/reactions.`);
  }

  // DELETE /repos/:did/:repo/pulls/comments/:id/reactions/:reaction_id
  const pullReviewCommentReactionMatch = rest.match(/^\/pulls\/comments\/(\d+)\/reactions\/(\d+)$/);
  if (pullReviewCommentReactionMatch) {
    if (method === 'DELETE') {
      return handleDeletePullReviewCommentReaction(
        ctx, targetDid, repoName, pullReviewCommentReactionMatch[1], pullReviewCommentReactionMatch[2],
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/comments/:id/reactions/:reaction_id.`);
  }

  // /repos/:did/:repo/pulls/comments/:id
  const pullReviewCommentMatch = rest.match(/^\/pulls\/comments\/(\d+)$/);
  if (pullReviewCommentMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'GET') {
      return handleGetPullReviewComment(ctx, targetDid, repoName, pullReviewCommentMatch[1], url, bodyMediaKind);
    }
    if (method === 'PATCH') {
      return handleUpdatePullReviewComment(
        ctx, targetDid, repoName, pullReviewCommentMatch[1], reqBody, url, bodyMediaKind,
      );
    }
    if (method === 'DELETE') { return handleDeletePullReviewComment(ctx, targetDid, repoName, pullReviewCommentMatch[1]); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/comments/:id.`);
  }

  // /repos/:did/:repo/pulls/:number.{diff,patch}
  const pullTextMatch = rest.match(/^\/pulls\/(\d+)\.(diff|patch)$/);
  if (pullTextMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number.:format.`); }
    return handleGetPullText(ctx, targetDid, repoName, pullTextMatch[1], pullTextMatch[2] as 'diff' | 'patch', options);
  }

  // /repos/:did/:repo/issues/:number
  const issueMatch = rest.match(/^\/issues\/(\d+)$/);
  if (issueMatch) {
    const bodyMediaKind = githubBodyMediaKind(options.accept);
    if (method === 'PATCH') { return handleUpdateIssue(ctx, targetDid, repoName, issueMatch[1], reqBody, url, bodyMediaKind); }
    if (method === 'GET') { return handleGetIssue(ctx, targetDid, repoName, issueMatch[1], url, bodyMediaKind); }
    return jsonMethodNotAllowed(`${method} not allowed on /issues/:number.`);
  }

  // /repos/:did/:repo/pulls/:number/merge
  const pullMergeMatch = rest.match(/^\/pulls\/(\d+)\/merge$/);
  if (pullMergeMatch) {
    if (method === 'GET') { return handleCheckPullMerged(ctx, targetDid, repoName, pullMergeMatch[1]); }
    if (method === 'PUT') { return handleMergePull(ctx, targetDid, repoName, pullMergeMatch[1], reqBody, url); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/merge.`);
  }

  // /repos/:did/:repo/pulls/:number/update-branch
  const pullUpdateBranchMatch = rest.match(/^\/pulls\/(\d+)\/update-branch$/);
  if (pullUpdateBranchMatch) {
    if (method !== 'PUT') { return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/update-branch.`); }
    return handleUpdatePullBranch(ctx, targetDid, repoName, pullUpdateBranchMatch[1], reqBody, url);
  }

  // /repos/:did/:repo/pulls/:number/commits
  const pullCommitsMatch = rest.match(/^\/pulls\/(\d+)\/commits$/);
  if (pullCommitsMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/commits.`); }
    return handleListPullCommits(ctx, targetDid, repoName, pullCommitsMatch[1], url, options);
  }

  // /repos/:did/:repo/pulls/:number/files
  const pullFilesMatch = rest.match(/^\/pulls\/(\d+)\/files$/);
  if (pullFilesMatch) {
    if (method !== 'GET') { return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/files.`); }
    return handleListPullFiles(ctx, targetDid, repoName, pullFilesMatch[1], url);
  }

  // /repos/:did/:repo/pulls/:number/requested_reviewers
  const pullRequestedReviewersMatch = rest.match(/^\/pulls\/(\d+)\/requested_reviewers$/);
  if (pullRequestedReviewersMatch) {
    if (method === 'GET') {
      return handleListPullRequestedReviewers(ctx, targetDid, repoName, pullRequestedReviewersMatch[1], url);
    }
    if (method === 'POST') {
      return handleRequestPullReviewers(ctx, targetDid, repoName, pullRequestedReviewersMatch[1], reqBody, url);
    }
    if (method === 'DELETE') {
      return handleRemovePullRequestedReviewers(ctx, targetDid, repoName, pullRequestedReviewersMatch[1], reqBody, url);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/requested_reviewers.`);
  }

  // /repos/:did/:repo/pulls/:number/comments/:comment_id/replies
  const pullReviewCommentRepliesMatch = rest.match(/^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/);
  if (pullReviewCommentRepliesMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'POST') {
      return handleCreatePullReviewCommentReply(
        ctx, targetDid, repoName, pullReviewCommentRepliesMatch[1], pullReviewCommentRepliesMatch[2],
        reqBody, url, bodyMediaKind,
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/comments/:comment_id/replies.`);
  }

  // /repos/:did/:repo/pulls/:number/comments
  const pullReviewCommentsMatch = rest.match(/^\/pulls\/(\d+)\/comments$/);
  if (pullReviewCommentsMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'POST') {
      return handleCreatePullReviewComment(ctx, targetDid, repoName, pullReviewCommentsMatch[1], reqBody, url, bodyMediaKind);
    }
    if (method === 'GET') {
      return handleListPullReviewComments(ctx, targetDid, repoName, pullReviewCommentsMatch[1], url, bodyMediaKind);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/comments.`);
  }

  // /repos/:did/:repo/pulls/:number/reviews
  const pullReviewsMatch = rest.match(/^\/pulls\/(\d+)\/reviews$/);
  if (pullReviewsMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'POST') {
      return handleCreatePullReview(ctx, targetDid, repoName, pullReviewsMatch[1], reqBody, url, bodyMediaKind);
    }
    if (method === 'GET') { return handleListPullReviews(ctx, targetDid, repoName, pullReviewsMatch[1], url, bodyMediaKind); }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/reviews.`);
  }

  // /repos/:did/:repo/pulls/:number/reviews/:review_id/comments
  const pullReviewCommentsForReviewMatch = rest.match(/^\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/);
  if (pullReviewCommentsForReviewMatch) {
    if (method === 'GET') {
      return handleListPullReviewCommentsForReview(
        ctx, targetDid, repoName, pullReviewCommentsForReviewMatch[1], pullReviewCommentsForReviewMatch[2], url,
        githubCommitCommentBodyMediaKind(options.accept),
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/reviews/:review_id/comments.`);
  }

  // /repos/:did/:repo/pulls/:number/reviews/:review_id/dismissals
  const pullReviewDismissalsMatch = rest.match(/^\/pulls\/(\d+)\/reviews\/(\d+)\/dismissals$/);
  if (pullReviewDismissalsMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'PUT') {
      return handleDismissPullReview(
        ctx, targetDid, repoName, pullReviewDismissalsMatch[1], pullReviewDismissalsMatch[2], reqBody, url,
        bodyMediaKind,
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/reviews/:review_id/dismissals.`);
  }

  // /repos/:did/:repo/pulls/:number/reviews/:review_id/events
  const pullReviewEventsMatch = rest.match(/^\/pulls\/(\d+)\/reviews\/(\d+)\/events$/);
  if (pullReviewEventsMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'POST') {
      return handleSubmitPullReview(
        ctx, targetDid, repoName, pullReviewEventsMatch[1], pullReviewEventsMatch[2], reqBody, url,
        bodyMediaKind,
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/reviews/:review_id/events.`);
  }

  // /repos/:did/:repo/pulls/:number/reviews/:review_id
  const pullReviewMatch = rest.match(/^\/pulls\/(\d+)\/reviews\/(\d+)$/);
  if (pullReviewMatch) {
    const bodyMediaKind = githubCommitCommentBodyMediaKind(options.accept);
    if (method === 'GET') {
      return handleGetPullReview(ctx, targetDid, repoName, pullReviewMatch[1], pullReviewMatch[2], url, bodyMediaKind);
    }
    if (method === 'PUT' || method === 'PATCH') {
      return handleUpdatePullReview(
        ctx, targetDid, repoName, pullReviewMatch[1], pullReviewMatch[2], reqBody, url, bodyMediaKind,
      );
    }
    if (method === 'DELETE') {
      return handleDeletePendingPullReview(
        ctx, targetDid, repoName, pullReviewMatch[1], pullReviewMatch[2], url, bodyMediaKind,
      );
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number/reviews/:review_id.`);
  }

  // /repos/:did/:repo/pulls/:number
  const pullMatch = rest.match(/^\/pulls\/(\d+)$/);
  if (pullMatch) {
    const bodyMediaKind = githubBodyMediaKind(options.accept);
    if (method === 'PATCH') { return handleUpdatePull(ctx, targetDid, repoName, pullMatch[1], reqBody, url, bodyMediaKind); }
    if (method === 'GET') {
      const textKind = githubTextMediaKind(options.accept);
      if (textKind) {
        return handleGetPullText(ctx, targetDid, repoName, pullMatch[1], textKind, options);
      }
      return handleGetPull(ctx, targetDid, repoName, pullMatch[1], url, bodyMediaKind);
    }
    return jsonMethodNotAllowed(`${method} not allowed on /pulls/:number.`);
  }

  return jsonNotFound('Not found');
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Start the GitHub API shim server. Returns the server instance. */
export function startShimServer(options: ShimServerOptions): Server {
  const { ctx, port, reposPath } = options;

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';

    // Health check endpoint.
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'github-api' }));
      return;
    }

    // Handle CORS preflight.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin'  : '*',
        'Access-Control-Allow-Methods' : 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers' : 'Authorization, Accept, Content-Type',
        'Access-Control-Max-Age'       : '86400',
      });
      res.end();
      return;
    }

    // Reject unsupported methods.
    if (!ALLOWED_METHODS.has(method)) {
      res.writeHead(405, baseHeaders());
      res.end(JSON.stringify({ message: `Method ${method} is not supported.` }));
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const isReleaseAssetUpload = method === 'POST' && RELEASE_ASSET_UPLOAD_RE.test(url.pathname);
      const isRawMarkdownRender = method === 'POST' && MARKDOWN_RAW_RE.test(url.pathname);
      const isRawBodyRequest = isReleaseAssetUpload || isRawMarkdownRender;

      // Parse request body for mutating methods (with size limit).
      let reqBody: Record<string, unknown> = {};
      let rawBody: Uint8Array | undefined;
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        let tooLarge = false;
        const maxBodySize = isReleaseAssetUpload ? MAX_BINARY_BODY : MAX_JSON_BODY;
        for await (const chunk of req) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalSize += buf.length;
          if (totalSize > maxBodySize) { tooLarge = true; break; }
          chunks.push(buf);
        }
        if (tooLarge) {
          res.writeHead(413, baseHeaders());
          res.end(JSON.stringify({ message: 'Payload Too Large' }));
          return;
        }
        const raw = Buffer.concat(chunks);
        if (isRawBodyRequest) {
          rawBody = raw;
        } else {
          const rawText = raw.toString('utf-8');
          if (rawText.length > 0) {
            try {
              reqBody = JSON.parse(rawText);
            } catch {
              res.writeHead(400, baseHeaders());
              res.end(JSON.stringify({ message: 'Invalid JSON in request body.' }));
              return;
            }
          }
        }
      }

      const authHeader = req.headers.authorization ?? null;
      const accept = headerValue(req.headers.accept);
      const contentType = headerValue(req.headers['content-type']);
      const requestOptions: ShimRequestOptions = { reposPath };
      if (accept) {
        requestOptions.accept = accept;
      }
      if (rawBody) {
        requestOptions.rawBody = rawBody;
      }
      if (isReleaseAssetUpload && contentType) {
        requestOptions.contentType = contentType;
      }
      const result = await handleShimRequest(ctx, url, method, reqBody, authHeader, requestOptions);

      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      console.error(`[github-shim] Error: ${(err as Error).message}`);
      res.writeHead(500, baseHeaders());
      res.end(JSON.stringify({ message: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    console.log(`[github-shim] GitHub API compatibility shim running at http://localhost:${port}`);
    console.log('[github-shim] Read endpoints (GET):');
    console.log('  GET  /                                      API root links');
    console.log('  GET  /meta                                  API metadata');
    console.log('  GET  /versions                              Supported API versions');
    console.log('  GET  /zen                                   Status phrase');
    console.log('  GET  /rate_limit                            Rate limit status');
    console.log('  GET  /emojis                                Emoji map');
    console.log('  GET  /gists                                 Authenticated user gists');
    console.log('  GET  /gists/public                          Public gists visible to local actor');
    console.log('  GET  /gists/starred                         Authenticated user starred gists');
    console.log('  GET  /gists/:gist_id                        Gist detail');
    console.log('  GET  /gists/:gist_id/:sha                   Gist revision detail');
    console.log('  GET  /gists/:gist_id/commits                Gist commits');
    console.log('  GET  /gists/:gist_id/comments               Gist comments');
    console.log('  GET  /gists/:gist_id/comments/:comment_id   Gist comment detail');
    console.log('  GET  /gists/:gist_id/forks                  Gist forks');
    console.log('  GET  /gists/:gist_id/raw/:filename          Raw gist file content');
    console.log('  GET  /gists/:gist_id/star                   Check gist star');
    console.log('  GET  /gitignore/templates                   Gitignore templates');
    console.log('  GET  /gitignore/templates/:name             Gitignore template');
    console.log('  GET  /licenses                              Common licenses');
    console.log('  GET  /licenses/:license                     License detail');
    console.log('  GET  /events                                Public activity events');
    console.log('  GET  /repositories                          Public repositories');
    console.log('  GET  /networks/:did/:repo/events            Network repository events');
    console.log('  GET  /repos/:did/:repo                  Repository info');
    console.log('  GET  /repos/:did/:repo/events           Repository events');
    console.log('  GET  /repos/:did/:repo/activity         Repository activity history');
    console.log('  GET  /repos/:did/:repo/forks            Repository forks');
    console.log('  GET  /repos/:did/:repo/readme           Repository README');
    console.log('  GET  /repos/:did/:repo/readme/:dir      Repository README for a directory');
    console.log('  GET  /repos/:did/:repo/license          Repository license');
    console.log('  GET  /repos/:did/:repo/contents[/path]  Repository git tree / metadata contents');
    console.log('  GET  /repos/:did/:repo/raw/:ref/:path   Repository raw file content');
    console.log('  GET  /repos/:did/:repo/tarball[/:ref]   Repository tar archive');
    console.log('  GET  /repos/:did/:repo/zipball[/:ref]   Repository zip archive');
    console.log('  GET  /repos/:did/:repo/branches         List branches');
    console.log('  GET  /repos/:did/:repo/branches/:branch Branch detail');
    console.log('  GET  /repos/:did/:repo/branches/:branch/protection Branch protection');
    console.log('  GET  /repos/:did/:repo/branches/:branch/protection/required_status_checks Status check protection');
    console.log('  GET  /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Status check contexts');
    console.log('  GET  /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews Pull request review protection');
    console.log('  GET  /repos/:did/:repo/tags             List tags');
    console.log('  GET  /repos/:did/:repo/teams            Repository teams');
    console.log('  GET  /repos/:did/:repo/git/ref/:ref     Git ref detail');
    console.log('  GET  /repos/:did/:repo/git/matching-refs/:ref Matching git refs');
    console.log('  GET  /repos/:did/:repo/git/blobs/:sha   Git blob object');
    console.log('  GET  /repos/:did/:repo/git/trees/:sha   Git tree object');
    console.log('  GET  /repos/:did/:repo/git/commits/:sha Low-level git commit object');
    console.log('  GET  /repos/:did/:repo/git/tags/:sha    Low-level git tag object');
    console.log('  GET  /repos/:did/:repo/community/profile Community profile metrics');
    console.log('  GET  /repos/:did/:repo/contributors     List contributors');
    console.log('  GET  /repos/:did/:repo/commits          List repository commits');
    console.log('  GET  /repos/:did/:repo/commits/:ref/comments Commit comments for commit');
    console.log('  GET  /repos/:did/:repo/commits/:ref     Repository commit object');
    console.log('  GET  /repos/:did/:repo/comments         Repository commit comments');
    console.log('  GET  /repos/:did/:repo/comments/:id     Commit comment detail');
    console.log('  GET  /repos/:did/:repo/comments/:id/reactions Commit comment reactions');
    console.log('  GET  /repos/:did/:repo/compare/:base...:head Compare commits');
    console.log('  GET  /repos/:did/:repo/compare/:base...:head.diff Compare commit diff');
    console.log('  GET  /repos/:did/:repo/compare/:base...:head.patch Compare commit patch');
    console.log('  GET  /repos/:did/:repo/stats/code_frequency Code frequency stats');
    console.log('  GET  /repos/:did/:repo/stats/commit_activity Commit activity stats');
    console.log('  GET  /repos/:did/:repo/stats/contributors Contributor activity stats');
    console.log('  GET  /repos/:did/:repo/stats/participation Participation stats');
    console.log('  GET  /repos/:did/:repo/stats/punch_card Commit punch card stats');
    console.log('  GET  /repos/:did/:repo/traffic/clones   Repository clone traffic');
    console.log('  GET  /repos/:did/:repo/traffic/popular/paths Popular repository paths');
    console.log('  GET  /repos/:did/:repo/traffic/popular/referrers Popular referrers');
    console.log('  GET  /repos/:did/:repo/traffic/views    Repository view traffic');
    console.log('  GET  /repos/:did/:repo/topics           Repository topics');
    console.log('  GET  /repos/:did/:repo/languages        Repository languages');
    console.log('  GET  /repos/:did/:repo/issue-types      Repository issue types');
    console.log('  GET  /repos/:did/:repo/properties/values Repository custom property values');
    console.log('  GET  /repos/:did/:repo/codeowners/errors Repository CODEOWNERS errors');
    console.log('  GET  /repos/:did/:repo/hash-algorithm   Repository hash algorithm');
    console.log('  GET  /repos/:did/:repo/attestations/:digest Repository artifact attestations');
    console.log('  GET  /repos/:did/:repo/keys             List deploy keys');
    console.log('  GET  /repos/:did/:repo/keys/:key_id     Deploy key detail');
    console.log('  GET  /repos/:did/:repo/autolinks        Repository autolinks');
    console.log('  GET  /repos/:did/:repo/autolinks/:id    Repository autolink detail');
    console.log('  GET  /repos/:did/:repo/interaction-limits Repository interaction restrictions');
    console.log('  GET  /repos/:did/:repo/vulnerability-alerts Repository vulnerability alerts status');
    console.log('  GET  /repos/:did/:repo/automated-security-fixes Dependabot security updates status');
    console.log('  GET  /repos/:did/:repo/immutable-releases Repository immutable releases status');
    console.log('  GET  /repos/:did/:repo/private-vulnerability-reporting Private vulnerability reporting status');
    console.log('  GET  /repos/:did/:repo/security-advisories Repository security advisories');
    console.log('  GET  /repos/:did/:repo/security-advisories/:ghsa_id Repository security advisory');
    console.log('  GET  /repos/:did/:repo/secret-scanning/alerts Repository secret scanning alerts');
    console.log('  GET  /repos/:did/:repo/secret-scanning/alerts/:number Repository secret scanning alert');
    console.log('  GET  /repos/:did/:repo/secret-scanning/alerts/:number/locations Repository secret scanning alert locations');
    console.log('  GET  /repos/:did/:repo/secret-scanning/scan-history Repository secret scanning scan history');
    console.log('  GET  /repos/:did/:repo/code-scanning/alerts Repository code scanning alerts');
    console.log('  GET  /repos/:did/:repo/code-scanning/alerts/:number Repository code scanning alert');
    console.log('  GET  /repos/:did/:repo/code-scanning/alerts/:number/instances Repository code scanning alert instances');
    console.log('  GET  /repos/:did/:repo/dependabot/alerts Repository Dependabot alerts');
    console.log('  GET  /repos/:did/:repo/dependabot/alerts/:number Repository Dependabot alert');
    console.log('  GET  /repos/:did/:repo/dependency-graph/sbom Repository SPDX SBOM');
    console.log('  GET  /repos/:did/:repo/dependency-graph/sbom/generate-report Request repository SBOM generation');
    console.log('  GET  /repos/:did/:repo/dependency-graph/sbom/fetch-report/:uuid Fetch generated repository SBOM report');
    console.log('  GET  /repos/:did/:repo/rules/branches/:branch Active branch rules');
    console.log('  GET  /repos/:did/:repo/rulesets/rule-suites Repository rule suites');
    console.log('  GET  /repos/:did/:repo/rulesets/rule-suites/:id Repository rule suite');
    console.log('  GET  /repos/:did/:repo/rulesets        Repository rulesets');
    console.log('  GET  /repos/:did/:repo/rulesets/:id    Repository ruleset detail');
    console.log('  GET  /repos/:did/:repo/rulesets/:id/history Repository ruleset history');
    console.log('  GET  /repos/:did/:repo/rulesets/:id/history/:version Repository ruleset version');
    console.log('  GET  /repos/:did/:repo/assignees        List assignable users');
    console.log('  GET  /repos/:did/:repo/assignees/:did   Check assignable user');
    console.log('  GET  /repos/:did/:repo/collaborators    List collaborators');
    console.log('  GET  /repos/:did/:repo/collaborators/:did Check collaborator');
    console.log('  GET  /repos/:did/:repo/collaborators/:did/permission Collaborator permission');
    console.log('  GET  /repos/:did/:repo/commits/:ref/status   Combined status');
    console.log('  GET  /repos/:did/:repo/commits/:ref/statuses Commit statuses');
    console.log('  GET  /repos/:did/:repo/commits/:ref/check-suites Check suites');
    console.log('  GET  /repos/:did/:repo/commits/:ref/check-runs Check runs');
    console.log('  GET  /repos/:did/:repo/check-suites/:id Check suite detail');
    console.log('  GET  /repos/:did/:repo/check-suites/:id/check-runs Check suite runs');
    console.log('  GET  /repos/:did/:repo/check-runs/:id   Check run detail');
    console.log('  GET  /repos/:did/:repo/check-runs/:id/annotations Check run annotations');
    console.log('  GET  /repos/:did/:repo/actions/artifacts Workflow artifacts');
    console.log('  GET  /repos/:did/:repo/actions/artifacts/:id Artifact detail');
    console.log('  GET  /repos/:did/:repo/actions/artifacts/:id/zip Download artifact');
    console.log('  GET  /repos/:did/:repo/actions/cache/retention-limit Actions cache retention limit');
    console.log('  GET  /repos/:did/:repo/actions/cache/storage-limit Actions cache storage limit');
    console.log('  GET  /repos/:did/:repo/actions/cache/usage Actions cache usage');
    console.log('  GET  /repos/:did/:repo/actions/caches Actions caches');
    console.log('  GET  /repos/:did/:repo/actions/permissions Actions permissions');
    console.log('  GET  /repos/:did/:repo/actions/permissions/selected-actions Allowed Actions settings');
    console.log('  GET  /repos/:did/:repo/actions/permissions/workflow Default workflow permissions');
    console.log('  GET  /repos/:did/:repo/actions/secrets Repository Actions secrets');
    console.log('  GET  /repos/:did/:repo/actions/secrets/public-key Repository secret public key');
    console.log('  GET  /repos/:did/:repo/actions/secrets/:name Repository Actions secret');
    console.log('  GET  /repos/:did/:repo/actions/variables Repository Actions variables');
    console.log('  GET  /repos/:did/:repo/actions/variables/:name Repository Actions variable');
    console.log('  GET  /repos/:did/:repo/actions/workflows Workflow definitions');
    console.log('  GET  /repos/:did/:repo/actions/workflows/:id Workflow definition detail');
    console.log('  GET  /repos/:did/:repo/actions/workflows/:id/runs Workflow runs for workflow');
    console.log('  GET  /repos/:did/:repo/actions/workflows/:id/timing Workflow usage');
    console.log('  GET  /repos/:did/:repo/actions/runs     Workflow runs');
    console.log('  GET  /repos/:did/:repo/actions/runs/:id Workflow run detail');
    console.log('  GET  /repos/:did/:repo/actions/runs/:id/attempts/:attempt Workflow run attempt');
    console.log('  GET  /repos/:did/:repo/actions/runs/:id/attempts/:attempt/logs Workflow run attempt logs');
    console.log('  GET  /repos/:did/:repo/actions/runs/:id/logs Workflow run logs');
    console.log('  GET  /repos/:did/:repo/actions/runs/:id/artifacts Workflow run artifacts');
    console.log('  GET  /repos/:did/:repo/actions/runs/:id/jobs Workflow run jobs');
    console.log('  GET  /repos/:did/:repo/actions/runs/:id/timing Workflow run usage');
    console.log('  GET  /repos/:did/:repo/actions/jobs/:id/logs Workflow job logs');
    console.log('  GET  /repos/:did/:repo/actions/jobs/:id Workflow job detail');
    console.log('  GET  /repos/:did/:repo/stargazers       Repository stargazers');
    console.log('  GET  /repos/:did/:repo/subscribers      Repository watchers/subscribers');
    console.log('  GET  /repos/:did/:repo/subscription     Authenticated repository subscription');
    console.log('  GET  /repos/:did/:repo/hooks            Repository webhooks');
    console.log('  GET  /repos/:did/:repo/hooks/:id        Repository webhook');
    console.log('  GET  /repos/:did/:repo/hooks/:id/config Repository webhook configuration');
    console.log('  GET  /repos/:did/:repo/hooks/:id/deliveries Repository webhook deliveries');
    console.log('  GET  /repos/:did/:repo/hooks/:id/deliveries/:delivery_id Repository webhook delivery');
    console.log('  GET  /repos/:did/:repo/labels           Repository labels');
    console.log('  GET  /repos/:did/:repo/labels/:name     Repository label detail');
    console.log('  GET  /repos/:did/:repo/milestones       Repository milestones');
    console.log('  GET  /repos/:did/:repo/milestones/:n    Milestone detail');
    console.log('  GET  /repos/:did/:repo/milestones/:n/labels Milestone labels');
    console.log('  GET  /issues                           Assigned issues');
    console.log('  GET  /user/issues                      Authenticated user issues');
    console.log('  GET  /orgs/:org/issues                 Organization issues');
    console.log('  GET  /repos/:did/:repo/issues           List issues');
    console.log('  GET  /repos/:did/:repo/issues/events    List repository issue events');
    console.log('  GET  /repos/:did/:repo/issues/events/:id Issue event detail');
    console.log('  GET  /repos/:did/:repo/issues/comments  List repository issue comments');
    console.log('  GET  /repos/:did/:repo/issues/comments/:id Issue comment detail');
    console.log('  GET  /repos/:did/:repo/issues/comments/:id/reactions Issue comment reactions');
    console.log('  GET  /repos/:did/:repo/issues/:number   Issue detail');
    console.log('  GET  /repos/:did/:repo/issues/:n/comments  Issue comments');
    console.log('  GET  /repos/:did/:repo/issues/:n/events Issue events');
    console.log('  GET  /repos/:did/:repo/issues/:n/timeline Issue timeline');
    console.log('  GET  /repos/:did/:repo/issues/:n/dependencies/blocked_by Issue blocked-by dependencies');
    console.log('  GET  /repos/:did/:repo/issues/:n/dependencies/blocking Issue blocking dependencies');
    console.log('  GET  /repos/:did/:repo/issues/:n/parent Parent issue');
    console.log('  GET  /repos/:did/:repo/issues/:n/sub_issues Sub-issues');
    console.log('  GET  /repos/:did/:repo/issues/:n/issue-field-values Issue field values');
    console.log('  GET  /repos/:did/:repo/issues/:n/reactions Issue reactions');
    console.log('  GET  /repos/:did/:repo/issues/:n/labels Issue labels');
    console.log('  GET  /repos/:did/:repo/pulls            List pull requests');
    console.log('  GET  /repos/:did/:repo/pulls/:number    Pull request detail');
    console.log('  GET  /repos/:did/:repo/pulls/:n.diff    Pull request diff');
    console.log('  GET  /repos/:did/:repo/pulls/:n.patch   Pull request patch');
    console.log('  GET  /repos/:did/:repo/pulls/:n/commits Pull request commits');
    console.log('  GET  /repos/:did/:repo/pulls/:n/comments Pull request review comments');
    console.log('  GET  /repos/:did/:repo/pulls/:n/files   Pull request files');
    console.log('  GET  /repos/:did/:repo/pulls/:n/reviews Pull request reviews');
    console.log('  GET  /repos/:did/:repo/pulls/:n/reviews/:id Pull request review');
    console.log('  GET  /repos/:did/:repo/pulls/:n/reviews/:id/comments Pull request review comments');
    console.log('  GET  /repos/:did/:repo/pulls/comments Repository pull review comments');
    console.log('  GET  /repos/:did/:repo/pulls/comments/:id Pull request review comment');
    console.log('  GET  /repos/:did/:repo/pulls/comments/:id/reactions Pull request review comment reactions');
    console.log('  GET  /repos/:did/:repo/releases         List releases');
    console.log('  GET  /repos/:did/:repo/releases/latest  Latest release');
    console.log('  GET  /repos/:did/:repo/releases/:id     Release detail');
    console.log('  GET  /repos/:did/:repo/releases/:id/reactions Release reactions');
    console.log('  GET  /repos/:did/:repo/releases/:id/assets Release assets');
    console.log('  GET  /repos/:did/:repo/releases/assets/:id Release asset metadata');
    console.log('  GET  /repos/:did/:repo/releases/assets/:id/download Release asset bytes');
    console.log('  GET  /repos/:did/:repo/releases/download/:tag/:asset Release asset download');
    console.log('  GET  /repos/:did/:repo/releases/tags/:t Release by tag');
    console.log('  GET  /repos/:did/:repo/environments     Deployment environments');
    console.log('  GET  /repos/:did/:repo/environments/:name Deployment environment detail');
    console.log('  GET  /repos/:did/:repo/environments/:name/secrets Environment secrets');
    console.log('  GET  /repos/:did/:repo/environments/:name/secrets/public-key Environment secret public key');
    console.log('  GET  /repos/:did/:repo/environments/:name/secrets/:secret Environment secret');
    console.log('  GET  /repos/:did/:repo/environments/:name/variables Environment variables');
    console.log('  GET  /repos/:did/:repo/environments/:name/variables/:var Environment variable');
    console.log('  GET  /repos/:did/:repo/deployments      List deployments');
    console.log('  GET  /repos/:did/:repo/deployments/:id  Deployment detail');
    console.log('  GET  /repos/:did/:repo/deployments/:id/statuses Deployment statuses');
    console.log('  GET  /repos/:did/:repo/deployments/:id/statuses/:status Deployment status');
    console.log('  GET  /repos/:did/:repo/pages            GitHub Pages site');
    console.log('  GET  /repos/:did/:repo/pages/builds     GitHub Pages builds');
    console.log('  GET  /repos/:did/:repo/pages/builds/latest Latest GitHub Pages build');
    console.log('  GET  /repos/:did/:repo/pages/builds/:id GitHub Pages build detail');
    console.log('  GET  /repos/:did/:repo/pages/deployments/:id GitHub Pages deployment status');
    console.log('  GET  /repos/:did/:repo/pages/deployments/:id/status GitHub Pages deployment status URL');
    console.log('  GET  /repos/:did/:repo/pages/health     GitHub Pages DNS health');
    console.log('  GET  /notifications                     Authenticated notifications');
    console.log('  GET  /notifications/threads/:id         Notification thread');
    console.log('  GET  /notifications/threads/:id/subscription Notification thread subscription');
    console.log('  GET  /organizations                     Public organizations');
    console.log('  GET  /orgs/:org                         Organization profile');
    console.log('  GET  /orgs/:org/members                 Organization members');
    console.log('  GET  /orgs/:org/members/:did            Check organization membership');
    console.log('  GET  /orgs/:org/memberships/:did        Organization membership detail');
    console.log('  GET  /orgs/:org/failed_invitations      Failed organization invitations');
    console.log('  GET  /orgs/:org/invitations             Pending organization invitations');
    console.log('  GET  /orgs/:org/invitations/:id/teams   Organization invitation teams');
    console.log('  GET  /orgs/:org/blocks                  Organization blocked users');
    console.log('  GET  /orgs/:org/blocks/:username        Check organization blocked user');
    console.log('  GET  /orgs/:org/hooks                   Organization webhooks');
    console.log('  GET  /orgs/:org/hooks/:id               Organization webhook');
    console.log('  GET  /orgs/:org/hooks/:id/config        Organization webhook configuration');
    console.log('  GET  /orgs/:org/hooks/:id/deliveries    Organization webhook deliveries');
    console.log('  GET  /orgs/:org/hooks/:id/deliveries/:delivery_id Organization webhook delivery');
    console.log('  GET  /orgs/:org/properties/schema       Organization custom property schema');
    console.log('  GET  /orgs/:org/properties/schema/:property Organization custom property');
    console.log('  GET  /orgs/:org/properties/values       Organization repository custom property values');
    console.log('  GET  /orgs/:org/issue-fields            Organization issue fields');
    console.log('  GET  /orgs/:org/issue-types             Organization issue types');
    console.log('  GET  /orgs/:org/outside_collaborators   Outside collaborators');
    console.log('  GET  /orgs/:org/public_members          Public organization members');
    console.log('  GET  /orgs/:org/public_members/:did      Check public organization membership');
    console.log('  GET  /orgs/:org/repos                   Organization repositories');
    console.log('  GET  /orgs/:org/code-scanning/alerts    Organization code scanning alerts');
    console.log('  GET  /orgs/:org/dependabot/alerts       Organization Dependabot alerts');
    console.log('  GET  /orgs/:org/secret-scanning/alerts  Organization secret scanning alerts');
    console.log('  GET  /orgs/:org/security-advisories     Organization repository security advisories');
    console.log('  GET  /orgs/:org/teams                   Organization teams');
    console.log('  GET  /orgs/:org/teams/:team             Organization team');
    console.log('  GET  /orgs/:org/teams/:team/teams       Child organization teams');
    console.log('  GET  /orgs/:org/teams/:team/invitations Pending team invitations');
    console.log('  GET  /orgs/:org/teams/:team/members     Organization team members');
    console.log('  GET  /orgs/:org/teams/:team/members/:did Check team membership');
    console.log('  GET  /orgs/:org/teams/:team/memberships/:did Get team membership');
    console.log('  GET  /orgs/:org/teams/:team/repos       Team repositories');
    console.log('  GET  /orgs/:org/teams/:team/repos/:did/:repo Check team repository permission');
    console.log('  GET  /organizations/:org_id/team/:team_id Organization team by numeric ID');
    console.log('  GET  /organizations/:org_id/team/:team_id/teams Child organization teams by numeric ID');
    console.log('  GET  /organizations/:org_id/team/:team_id/invitations Pending team invitations by numeric ID');
    console.log('  GET  /organizations/:org_id/team/:team_id/members Organization team members by numeric ID');
    console.log('  GET  /organizations/:org_id/team/:team_id/memberships/:did Get team membership by numeric ID');
    console.log('  GET  /organizations/:org_id/team/:team_id/repos Team repositories by numeric ID');
    console.log('  GET  /organizations/:org_id/team/:team_id/repos/:did/:repo Check team repository permission by numeric ID');
    console.log('  GET  /teams/:team_id                    Legacy team by numeric ID');
    console.log('  GET  /teams/:team_id/teams              Legacy child organization teams by numeric ID');
    console.log('  GET  /teams/:team_id/invitations        Legacy pending team invitations by numeric ID');
    console.log('  GET  /teams/:team_id/members            Legacy organization team members by numeric ID');
    console.log('  GET  /teams/:team_id/members/:did       Legacy check team membership by numeric ID');
    console.log('  GET  /teams/:team_id/memberships/:did   Legacy get team membership by numeric ID');
    console.log('  GET  /teams/:team_id/repos              Legacy team repositories by numeric ID');
    console.log('  GET  /teams/:team_id/repos/:did/:repo   Legacy check team repository permission by numeric ID');
    console.log('  GET  /repos/:did/:repo/notifications    Repository notifications');
    console.log('  GET  /search/code                       Search code');
    console.log('  GET  /search/commits                    Search commits');
    console.log('  GET  /search/issues                     Search issues and pull requests');
    console.log('  GET  /search/labels                     Search repository labels');
    console.log('  GET  /search/repositories               Search repositories');
    console.log('  GET  /search/topics                     Search topics');
    console.log('  GET  /search/users                      Search users');
    console.log('  GET  /user                              Authenticated user profile');
    console.log('  GET  /user/repos                        Authenticated repositories');
    console.log('  GET  /user/orgs                         Authenticated organizations');
    console.log('  GET  /user/memberships/orgs             Authenticated organization memberships');
    console.log('  GET  /user/memberships/orgs/:org        Authenticated organization membership');
    console.log('  GET  /user/teams                        Authenticated teams');
    console.log('  GET  /user/emails                       Authenticated email addresses');
    console.log('  GET  /user/public_emails                Authenticated public email addresses');
    console.log('  GET  /user/gpg_keys                     Authenticated GPG keys');
    console.log('  GET  /user/gpg_keys/:id                 Authenticated GPG key');
    console.log('  GET  /user/social_accounts              Authenticated social accounts');
    console.log('  GET  /user/keys                         Authenticated SSH keys');
    console.log('  GET  /user/keys/:key_id                 Authenticated SSH key');
    console.log('  GET  /user/ssh_signing_keys             Authenticated SSH signing keys');
    console.log('  GET  /user/ssh_signing_keys/:id         Authenticated SSH signing key');
    console.log('  GET  /user/blocks                       Authenticated blocked users');
    console.log('  GET  /user/blocks/:did                  Check authenticated blocked user');
    console.log('  GET  /user/followers                    Authenticated followers');
    console.log('  GET  /user/following                    Authenticated following');
    console.log('  GET  /user/following/:did               Check authenticated follow');
    console.log('  GET  /user/starred                      Authenticated starred repos');
    console.log('  GET  /user/starred/:did/:repo           Check authenticated user star');
    console.log('  GET  /user/subscriptions                Authenticated watched repos');
    console.log('  GET  /user/:account_id                  User profile by numeric ID');
    console.log('  GET  /users/:did/followers              User followers');
    console.log('  GET  /users/:did/following              User following');
    console.log('  GET  /users/:did/following/:target      Check if user follows target');
    console.log('  GET  /users/:did/events                 User events');
    console.log('  GET  /users/:did/events/public          User public events');
    console.log('  GET  /users/:did/received_events        User received events');
    console.log('  GET  /users/:did/received_events/public User public received events');
    console.log('  GET  /users/:did/repos                  User repositories');
    console.log('  GET  /users/:did/gists                  User public gists');
    console.log('  GET  /users/:did/gpg_keys               User public GPG keys');
    console.log('  GET  /users/:did/social_accounts        User public social accounts');
    console.log('  GET  /users/:did/keys                   User public SSH keys');
    console.log('  GET  /users/:did/ssh_signing_keys       User public SSH signing keys');
    console.log('  GET  /users/:did/orgs                   User public organizations');
    console.log('  GET  /users/:did/starred                User starred repos');
    console.log('  GET  /users/:did/subscriptions          User watched repos');
    console.log('  GET  /users/:did/hovercard              User hovercard contexts');
    console.log('  GET  /users/:did/attestations/:digest   User artifact attestations');
    console.log('  GET  /users/:did                        User profile');
    console.log('  GET  /users                             Public users visible to local actor');
    console.log('[github-shim] Write endpoints (POST/PATCH/PUT/DELETE):');
    console.log('  POST  /markdown                             Render Markdown');
    console.log('  POST  /markdown/raw                         Render raw Markdown');
    console.log('  POST  /gists                                Create a gist');
    console.log('  POST  /gists/:gist_id/comments              Create a gist comment');
    console.log('  POST  /gists/:gist_id/forks                 Fork a gist');
    console.log('  PATCH /gists/:gist_id                       Update a gist');
    console.log('  PATCH /gists/:gist_id/comments/:comment_id  Update a gist comment');
    console.log('  PUT   /gists/:gist_id/star                  Star a gist');
    console.log('  DELETE /gists/:gist_id                      Delete a gist');
    console.log('  DELETE /gists/:gist_id/comments/:comment_id Delete a gist comment');
    console.log('  DELETE /gists/:gist_id/star                 Unstar a gist');
    console.log('  PATCH /repos/:did/:repo                    Update repository metadata');
    console.log('  DELETE /repos/:did/:repo                   Delete repository');
    console.log('  POST  /repos/:did/:repo/forks              Create a fork');
    console.log('  POST  /repos/:did/:repo/generate           Create repository from template');
    console.log('  POST  /repos/:did/:repo/transfer           Request repository transfer');
    console.log('  PUT   /repos/:did/:repo/contents/:path    Create or update file contents');
    console.log('  DELETE /repos/:did/:repo/contents/:path   Delete file contents');
    console.log('  POST  /repos/:did/:repo/git/blobs         Create git blob object');
    console.log('  POST  /repos/:did/:repo/git/trees         Create git tree object');
    console.log('  POST  /repos/:did/:repo/git/commits       Create git commit object');
    console.log('  POST  /repos/:did/:repo/git/tags          Create git tag object');
    console.log('  POST  /repos/:did/:repo/git/refs          Create git reference');
    console.log('  PATCH /repos/:did/:repo/git/refs/:ref     Update git reference');
    console.log('  DELETE /repos/:did/:repo/git/refs/:ref    Delete git reference');
    console.log('  POST  /repos/:did/:repo/commits/:sha/comments Create commit comment');
    console.log('  PATCH /repos/:did/:repo/comments/:id     Update commit comment');
    console.log('  DELETE /repos/:did/:repo/comments/:id    Delete commit comment');
    console.log('  POST  /repos/:did/:repo/comments/:id/reactions Create commit comment reaction');
    console.log('  DELETE /repos/:did/:repo/comments/:id/reactions/:rid Delete commit comment reaction');
    console.log('  POST  /repos/:did/:repo/issues            Create issue');
    console.log('  PATCH /repos/:did/:repo/issues/:number    Update issue');
    console.log('  POST  /repos/:did/:repo/issues/:n/comments  Create comment');
    console.log('  PATCH /repos/:did/:repo/issues/comments/:id Update issue comment');
    console.log('  DELETE /repos/:did/:repo/issues/comments/:id Delete issue comment');
    console.log('  PUT   /repos/:did/:repo/issues/comments/:id/pin Pin issue comment');
    console.log('  DELETE /repos/:did/:repo/issues/comments/:id/pin Unpin issue comment');
    console.log('  POST  /repos/:did/:repo/issues/comments/:id/reactions Create issue comment reaction');
    console.log('  DELETE /repos/:did/:repo/issues/comments/:id/reactions/:rid Delete issue comment reaction');
    console.log('  POST  /repos/:did/:repo/issues/:n/reactions Create issue reaction');
    console.log('  DELETE /repos/:did/:repo/issues/:n/reactions/:rid Delete issue reaction');
    console.log('  POST  /repos/:did/:repo/issues/:n/dependencies/blocked_by Add issue dependency');
    console.log('  DELETE /repos/:did/:repo/issues/:n/dependencies/blocked_by/:iid Remove issue dependency');
    console.log('  POST  /repos/:did/:repo/issues/:n/sub_issues Add sub-issue');
    console.log('  DELETE /repos/:did/:repo/issues/:n/sub_issue Remove sub-issue');
    console.log('  PATCH /repos/:did/:repo/issues/:n/sub_issues/priority Reprioritize sub-issue');
    console.log('  POST  /repos/:did/:repo/issues/:n/issue-field-values Add issue field values');
    console.log('  PUT   /repos/:did/:repo/issues/:n/issue-field-values Set issue field values');
    console.log('  DELETE /repos/:did/:repo/issues/:n/issue-field-values/:fid Delete issue field value');
    console.log('  POST  /repos/:did/:repo/issues/:n/labels Add labels');
    console.log('  PUT   /repos/:did/:repo/issues/:n/labels Replace labels');
    console.log('  DELETE /repos/:did/:repo/issues/:n/labels Remove all labels');
    console.log('  DELETE /repos/:did/:repo/issues/:n/labels/:name Remove label');
    console.log('  POST  /repos/:did/:repo/labels           Create repository label');
    console.log('  PATCH /repos/:did/:repo/labels/:name     Update repository label');
    console.log('  DELETE /repos/:did/:repo/labels/:name    Delete repository label');
    console.log('  POST  /repos/:did/:repo/milestones       Create milestone');
    console.log('  PATCH /repos/:did/:repo/milestones/:n    Update milestone');
    console.log('  DELETE /repos/:did/:repo/milestones/:n   Delete milestone');
    console.log('  PUT   /repos/:did/:repo/issues/:n/lock   Lock issue');
    console.log('  DELETE /repos/:did/:repo/issues/:n/lock  Unlock issue');
    console.log('  POST  /repos/:did/:repo/issues/:n/assignees Add assignees');
    console.log('  DELETE /repos/:did/:repo/issues/:n/assignees Remove assignees');
    console.log('  POST  /repos/:did/:repo/pulls             Create pull request');
    console.log('  PATCH /repos/:did/:repo/pulls/:number     Update pull request');
    console.log('  PUT   /repos/:did/:repo/pulls/:n/merge    Merge pull request');
    console.log('  POST  /repos/:did/:repo/pulls/:n/comments Create review comment');
    console.log('  PATCH /repos/:did/:repo/pulls/comments/:id Update review comment');
    console.log('  DELETE /repos/:did/:repo/pulls/comments/:id Delete review comment');
    console.log('  POST  /repos/:did/:repo/pulls/comments/:id/reactions Create review comment reaction');
    console.log('  DELETE /repos/:did/:repo/pulls/comments/:id/reactions/:rid Delete review comment reaction');
    console.log('  POST  /repos/:did/:repo/pulls/:n/comments/:id/replies Create review comment reply');
    console.log('  POST  /repos/:did/:repo/pulls/:n/reviews  Create review');
    console.log('  PATCH /repos/:did/:repo/pulls/:n/reviews/:id Update review');
    console.log('  DELETE /repos/:did/:repo/pulls/:n/reviews/:id Delete pending review');
    console.log('  PUT   /repos/:did/:repo/pulls/:n/reviews/:id/dismissals Dismiss review');
    console.log('  POST  /repos/:did/:repo/pulls/:n/reviews/:id/events Submit review');
    console.log('  POST  /repos/:did/:repo/releases          Create release');
    console.log('  POST  /repos/:did/:repo/releases/generate-notes Generate release notes');
    console.log('  POST  /repos/:did/:repo/releases/:id/assets Upload release asset');
    console.log('  PATCH /repos/:did/:repo/releases/:id      Update release');
    console.log('  DELETE /repos/:did/:repo/releases/:id     Delete release');
    console.log('  POST  /repos/:did/:repo/releases/:id/reactions Create release reaction');
    console.log('  DELETE /repos/:did/:repo/releases/:id/reactions/:rid Delete release reaction');
    console.log('  PATCH /repos/:did/:repo/releases/assets/:id Update release asset');
    console.log('  DELETE /repos/:did/:repo/releases/assets/:id Delete release asset');
    console.log('  PUT   /repos/:did/:repo/environments/:name Create/update deployment environment');
    console.log('  DELETE /repos/:did/:repo/environments/:name Delete deployment environment');
    console.log('  PUT   /repos/:did/:repo/environments/:name/secrets/:secret Create/update environment secret');
    console.log('  DELETE /repos/:did/:repo/environments/:name/secrets/:secret Delete environment secret');
    console.log('  POST  /repos/:did/:repo/environments/:name/variables Create environment variable');
    console.log('  PATCH /repos/:did/:repo/environments/:name/variables/:var Update environment variable');
    console.log('  DELETE /repos/:did/:repo/environments/:name/variables/:var Delete environment variable');
    console.log('  POST  /repos/:did/:repo/deployments       Create deployment');
    console.log('  DELETE /repos/:did/:repo/deployments/:id  Delete deployment');
    console.log('  POST  /repos/:did/:repo/deployments/:id/statuses Create deployment status');
    console.log('  POST  /repos/:did/:repo/pages             Create GitHub Pages site');
    console.log('  PUT   /repos/:did/:repo/pages             Update GitHub Pages site');
    console.log('  DELETE /repos/:did/:repo/pages            Delete GitHub Pages site');
    console.log('  POST  /repos/:did/:repo/pages/builds      Request GitHub Pages build');
    console.log('  POST  /repos/:did/:repo/pages/deployments Create GitHub Pages deployment');
    console.log('  POST  /repos/:did/:repo/pages/deployments/:id/cancel Cancel GitHub Pages deployment');
    console.log('  POST  /repos/:did/:repo/statuses/:sha     Create commit status');
    console.log('  POST  /repos/:did/:repo/check-suites      Create check suite');
    console.log('  POST  /repos/:did/:repo/check-suites/:id/rerequest Rerequest check suite');
    console.log('  POST  /repos/:did/:repo/check-runs        Create check run');
    console.log('  PATCH /repos/:did/:repo/check-runs/:id    Update check run');
    console.log('  POST  /repos/:did/:repo/check-runs/:id/rerequest Rerequest check run');
    console.log('  PUT   /repos/:did/:repo/actions/cache/retention-limit Set Actions cache retention limit');
    console.log('  PUT   /repos/:did/:repo/actions/cache/storage-limit Set Actions cache storage limit');
    console.log('  DELETE /repos/:did/:repo/actions/caches Delete Actions caches by key');
    console.log('  DELETE /repos/:did/:repo/actions/caches/:id Delete Actions cache by ID');
    console.log('  PUT   /repos/:did/:repo/actions/permissions Set Actions permissions');
    console.log('  PUT   /repos/:did/:repo/actions/permissions/selected-actions Set allowed Actions settings');
    console.log('  PUT   /repos/:did/:repo/actions/permissions/workflow Set default workflow permissions');
    console.log('  DELETE /repos/:did/:repo/actions/artifacts/:id Delete artifact');
    console.log('  PUT   /repos/:did/:repo/actions/secrets/:name Create/update repository secret');
    console.log('  DELETE /repos/:did/:repo/actions/secrets/:name Delete repository secret');
    console.log('  POST  /repos/:did/:repo/actions/variables Create repository Actions variable');
    console.log('  PATCH /repos/:did/:repo/actions/variables/:name Update repository Actions variable');
    console.log('  DELETE /repos/:did/:repo/actions/variables/:name Delete repository Actions variable');
    console.log('  PUT   /repos/:did/:repo/actions/workflows/:id/disable Disable workflow');
    console.log('  POST  /repos/:did/:repo/actions/workflows/:id/dispatches Dispatch workflow');
    console.log('  PUT   /repos/:did/:repo/actions/workflows/:id/enable Enable workflow');
    console.log('  POST  /repos/:did/:repo/actions/runs/:id/rerun Re-run workflow run');
    console.log('  POST  /repos/:did/:repo/actions/runs/:id/rerun-failed-jobs Re-run failed workflow jobs');
    console.log('  POST  /repos/:did/:repo/actions/runs/:id/cancel Cancel workflow run');
    console.log('  POST  /repos/:did/:repo/actions/runs/:id/force-cancel Force cancel workflow run');
    console.log('  DELETE /repos/:did/:repo/actions/runs/:id Delete workflow run');
    console.log('  DELETE /repos/:did/:repo/actions/runs/:id/logs Delete workflow run logs');
    console.log('  POST  /repos/:did/:repo/actions/jobs/:id/rerun Re-run workflow job');
    console.log('  POST  /users/:did/attestations/bulk-list List user artifact attestations by digests');
    console.log('  DELETE /users/:did/attestations          Delete user artifact attestations in bulk');
    console.log('  DELETE /users/:did/attestations/digest/:digest Delete user artifact attestations by digest');
    console.log('  DELETE /users/:did/attestations/:id      Delete user artifact attestation by ID');
    console.log('  PUT   /repos/:did/:repo/subscription      Set repository subscription');
    console.log('  DELETE /repos/:did/:repo/subscription     Delete repository subscription');
    console.log('  PUT   /repos/:did/:repo/branches/:branch/protection Update branch protection');
    console.log('  DELETE /repos/:did/:repo/branches/:branch/protection Delete branch protection');
    console.log('  PATCH /repos/:did/:repo/branches/:branch/protection/required_status_checks Update status check protection');
    console.log('  DELETE /repos/:did/:repo/branches/:branch/protection/required_status_checks Delete status check protection');
    console.log('  POST  /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Add status check contexts');
    console.log('  PUT   /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Set status check contexts');
    console.log('  DELETE /repos/:did/:repo/branches/:branch/protection/required_status_checks/contexts Remove status check contexts');
    console.log('  PATCH /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews Update pull request review protection');
    console.log('  DELETE /repos/:did/:repo/branches/:branch/protection/required_pull_request_reviews Delete pull request review protection');
    console.log('  PUT   /repos/:did/:repo/topics            Replace topics');
    console.log('  POST  /repos/:did/:repo/keys              Create deploy key');
    console.log('  DELETE /repos/:did/:repo/keys/:key_id     Delete deploy key');
    console.log('  POST  /repos/:did/:repo/autolinks         Create repository autolink');
    console.log('  DELETE /repos/:did/:repo/autolinks/:id    Delete repository autolink');
    console.log('  PUT   /repos/:did/:repo/interaction-limits Set repository interaction restrictions');
    console.log('  DELETE /repos/:did/:repo/interaction-limits Remove repository interaction restrictions');
    console.log('  PATCH /repos/:did/:repo/properties/values Update repository custom properties');
    console.log('  POST  /repos/:did/:repo/dispatches        Create repository dispatch event');
    console.log('  POST  /repos/:did/:repo/attestations      Create repository artifact attestation');
    console.log('  PUT   /repos/:did/:repo/vulnerability-alerts Enable vulnerability alerts');
    console.log('  DELETE /repos/:did/:repo/vulnerability-alerts Disable vulnerability alerts');
    console.log('  PUT   /repos/:did/:repo/automated-security-fixes Enable Dependabot security updates');
    console.log('  DELETE /repos/:did/:repo/automated-security-fixes Disable Dependabot security updates');
    console.log('  PUT   /repos/:did/:repo/immutable-releases Enable immutable releases');
    console.log('  DELETE /repos/:did/:repo/immutable-releases Disable immutable releases');
    console.log('  PUT   /repos/:did/:repo/private-vulnerability-reporting Enable private vulnerability reporting');
    console.log('  DELETE /repos/:did/:repo/private-vulnerability-reporting Disable private vulnerability reporting');
    console.log('  POST  /repos/:did/:repo/security-advisories Create repository security advisory');
    console.log('  POST  /repos/:did/:repo/security-advisories/reports Privately report security vulnerability');
    console.log('  PATCH /repos/:did/:repo/security-advisories/:ghsa_id Update repository security advisory');
    console.log('  POST  /repos/:did/:repo/security-advisories/:ghsa_id/cve Request repository advisory CVE');
    console.log('  POST  /repos/:did/:repo/security-advisories/:ghsa_id/forks Create temporary private fork');
    console.log('  POST  /repos/:did/:repo/secret-scanning/push-protection-bypasses Create secret scanning push protection bypass');
    console.log('  PATCH /repos/:did/:repo/code-scanning/alerts/:number Update repository code scanning alert');
    console.log('  PATCH /repos/:did/:repo/dependabot/alerts/:number Update repository Dependabot alert');
    console.log('  PATCH /repos/:did/:repo/secret-scanning/alerts/:number Update repository secret scanning alert');
    console.log('  POST  /repos/:did/:repo/rulesets          Create repository ruleset');
    console.log('  PUT   /repos/:did/:repo/rulesets/:id      Update repository ruleset');
    console.log('  DELETE /repos/:did/:repo/rulesets/:id     Delete repository ruleset');
    console.log('  PUT   /repos/:did/:repo/collaborators/:did Add collaborator');
    console.log('  DELETE /repos/:did/:repo/collaborators/:did Remove collaborator');
    console.log('  POST  /repos/:did/:repo/hooks             Create repository webhook');
    console.log('  PATCH /repos/:did/:repo/hooks/:id         Update repository webhook');
    console.log('  DELETE /repos/:did/:repo/hooks/:id        Delete repository webhook');
    console.log('  PATCH /repos/:did/:repo/hooks/:id/config  Update repository webhook configuration');
    console.log('  POST  /repos/:did/:repo/hooks/:id/deliveries/:delivery_id/attempts Redeliver repository webhook delivery');
    console.log('  POST  /repos/:did/:repo/hooks/:id/pings   Ping repository webhook');
    console.log('  POST  /repos/:did/:repo/hooks/:id/tests   Test repository webhook');
    console.log('  PUT   /notifications                      Mark notifications as read');
    console.log('  PATCH /notifications/threads/:id          Mark notification thread as read');
    console.log('  DELETE /notifications/threads/:id         Mark notification thread as done');
    console.log('  PUT   /notifications/threads/:id/subscription Set notification thread subscription');
    console.log('  DELETE /notifications/threads/:id/subscription Delete notification thread subscription');
    console.log('  PATCH /orgs/:org                          Update organization profile');
    console.log('  DELETE /orgs/:org/members/:did            Remove organization member');
    console.log('  PUT   /orgs/:org/memberships/:did        Set organization membership');
    console.log('  DELETE /orgs/:org/memberships/:did        Remove organization membership');
    console.log('  DELETE /orgs/:org/invitations/:id         Cancel organization invitation');
    console.log('  PUT   /orgs/:org/blocks/:username         Block organization user');
    console.log('  DELETE /orgs/:org/blocks/:username        Unblock organization user');
    console.log('  POST  /orgs/:org/hooks                    Create organization webhook');
    console.log('  PATCH /orgs/:org/hooks/:id                Update organization webhook');
    console.log('  DELETE /orgs/:org/hooks/:id               Delete organization webhook');
    console.log('  PATCH /orgs/:org/hooks/:id/config         Update organization webhook configuration');
    console.log('  POST  /orgs/:org/hooks/:id/deliveries/:delivery_id/attempts Redeliver organization webhook delivery');
    console.log('  POST  /orgs/:org/hooks/:id/pings          Ping organization webhook');
    console.log('  PATCH /orgs/:org/properties/schema        Create/update organization custom properties');
    console.log('  PUT   /orgs/:org/properties/schema/:property Create/update organization custom property');
    console.log('  DELETE /orgs/:org/properties/schema/:property Delete organization custom property');
    console.log('  PATCH /orgs/:org/properties/values        Update organization repository custom property values');
    console.log('  POST  /orgs/:org/issue-fields             Create organization issue field');
    console.log('  PATCH /orgs/:org/issue-fields/:field      Update organization issue field');
    console.log('  DELETE /orgs/:org/issue-fields/:field     Delete organization issue field');
    console.log('  POST  /orgs/:org/issue-types              Create organization issue type');
    console.log('  PUT   /orgs/:org/issue-types/:type        Update organization issue type');
    console.log('  DELETE /orgs/:org/issue-types/:type       Delete organization issue type');
    console.log('  PUT   /orgs/:org/outside_collaborators/:did Convert member to outside collaborator');
    console.log('  DELETE /orgs/:org/outside_collaborators/:did Remove outside collaborator');
    console.log('  PUT   /orgs/:org/public_members/:did      Set public organization membership');
    console.log('  DELETE /orgs/:org/public_members/:did     Remove public organization membership');
    console.log('  POST  /orgs/:org/repos                    Create organization repository');
    console.log('  POST  /orgs/:org/teams                    Create organization team');
    console.log('  PATCH /orgs/:org/teams/:team              Update organization team');
    console.log('  DELETE /orgs/:org/teams/:team             Delete organization team');
    console.log('  PUT   /orgs/:org/teams/:team/repos/:did/:repo Add/update team repository permission');
    console.log('  DELETE /orgs/:org/teams/:team/repos/:did/:repo Remove team repository permission');
    console.log('  PUT   /orgs/:org/teams/:team/memberships/:did Add organization team membership');
    console.log('  DELETE /orgs/:org/teams/:team/memberships/:did Remove organization team membership');
    console.log('  PATCH /organizations/:org_id/team/:team_id Update organization team by numeric ID');
    console.log('  DELETE /organizations/:org_id/team/:team_id Delete organization team by numeric ID');
    console.log('  PUT   /organizations/:org_id/team/:team_id/memberships/:did Add team membership by numeric ID');
    console.log('  DELETE /organizations/:org_id/team/:team_id/memberships/:did Remove team membership by numeric ID');
    console.log('  PUT   /organizations/:org_id/team/:team_id/repos/:did/:repo Add/update team repository permission by numeric ID');
    console.log('  DELETE /organizations/:org_id/team/:team_id/repos/:did/:repo Remove team repository permission by numeric ID');
    console.log('  PATCH /teams/:team_id                    Legacy update organization team by numeric ID');
    console.log('  DELETE /teams/:team_id                   Legacy delete organization team by numeric ID');
    console.log('  PUT   /teams/:team_id/members/:did       Legacy add organization team membership by numeric ID');
    console.log('  DELETE /teams/:team_id/members/:did      Legacy remove organization team membership by numeric ID');
    console.log('  PUT   /teams/:team_id/memberships/:did   Legacy add organization team membership by numeric ID');
    console.log('  DELETE /teams/:team_id/memberships/:did  Legacy remove organization team membership by numeric ID');
    console.log('  PUT   /teams/:team_id/repos/:did/:repo   Legacy add/update team repository permission by numeric ID');
    console.log('  DELETE /teams/:team_id/repos/:did/:repo  Legacy remove team repository permission by numeric ID');
    console.log('  PUT   /repos/:did/:repo/notifications     Mark repository notifications as read');
    console.log('  PATCH /user                                Update authenticated user profile');
    console.log('  PATCH /user/memberships/orgs/:org         Update authenticated organization membership');
    console.log('  PATCH /user/email/visibility              Set primary email visibility');
    console.log('  POST  /user/emails                        Add authenticated email addresses');
    console.log('  DELETE /user/emails                       Delete authenticated email addresses');
    console.log('  POST  /user/gpg_keys                      Create authenticated GPG key');
    console.log('  DELETE /user/gpg_keys/:id                 Delete authenticated GPG key');
    console.log('  POST  /user/social_accounts               Add authenticated social accounts');
    console.log('  DELETE /user/social_accounts              Delete authenticated social accounts');
    console.log('  POST  /user/keys                          Create authenticated SSH key');
    console.log('  DELETE /user/keys/:key_id                 Delete authenticated SSH key');
    console.log('  POST  /user/ssh_signing_keys              Create authenticated SSH signing key');
    console.log('  DELETE /user/ssh_signing_keys/:id         Delete authenticated SSH signing key');
    console.log('  POST  /user/repos                         Create authenticated repository');
    console.log('  PUT   /user/blocks/:did                   Block a user');
    console.log('  DELETE /user/blocks/:did                  Unblock a user');
    console.log('  PUT   /user/following/:did                Follow a user');
    console.log('  DELETE /user/following/:did               Unfollow a user');
    console.log('  PUT   /user/starred/:did/:repo            Star repository');
    console.log('  DELETE /user/starred/:did/:repo           Unstar repository');
    console.log('');
  });

  return server;
}
