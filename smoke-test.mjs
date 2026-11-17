// Smoke test for the github-core-clone entry: boots the app on an ephemeral port and exercises
// REST, git smart HTTP (via real `git` CLI as the client), GraphQL and MCP.
import { createApp } from './app.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-token-123';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
const server = createApp();
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
}
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' };
async function req(method, path, body, headers = H) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, text, json };
}

// healthz + root + meta + user
let r = await req('GET', '/healthz', undefined, {});
check('healthz', r.status === 200 && r.json?.ok === true);
r = await req('GET', '/api/v3/', undefined, {});
check('api root', r.status === 200 && (r.headers.get('x-oauth-scopes') ?? '').includes('repo'));
r = await req('GET', '/api/v3/meta');
check('meta', r.status === 200 && typeof r.json?.installed_version === 'string');
r = await req('GET', '/api/v3/user');
check('user login adaiversen', r.status === 200 && r.json?.login === 'adaiversen', `login=${r.json?.login}`);
r = await req('GET', '/api/v3/user', undefined, {});
check('no token 401', r.status === 401);

// create repo
r = await req('POST', '/api/v3/user/repos', { name: 'smoke', description: 'smoke repo', private: true });
check('create repo', r.status === 201 && r.json?.name === 'smoke', `status=${r.status}`);
r = await req('GET', '/api/v3/repos/adaiversen/smoke');
check('get repo', r.status === 200 && r.json?.default_branch === 'main');
r = await req('GET', '/api/v3/repos/other/smoke');
check('foreign owner 404', r.status === 404);

// contents: create file, read, update, directory listing
r = await req('PUT', '/api/v3/repos/adaiversen/smoke/contents/README.md', { message: 'add readme', content: Buffer.from('hello world\n').toString('base64') });
check('contents create 201', r.status === 201, `status=${r.status} ${r.text.slice(0, 120)}`);
const blobSha = r.json?.content?.sha;
r = await req('GET', '/api/v3/repos/adaiversen/smoke/contents/README.md');
check('contents get', r.status === 200 && Buffer.from(r.json?.content ?? '', 'base64').toString() === 'hello world\n');
r = await req('PUT', '/api/v3/repos/adaiversen/smoke/contents/README.md', { message: 'upd', content: Buffer.from('hello v2\n').toString('base64'), sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
check('contents stale sha 409', r.status === 409);
r = await req('PUT', '/api/v3/repos/adaiversen/smoke/contents/README.md', { message: 'upd', content: Buffer.from('hello v2\n').toString('base64'), sha: blobSha });
check('contents update 200', r.status === 200);
r = await req('PUT', '/api/v3/repos/adaiversen/smoke/contents/src/index.ts', { message: 'add src', content: Buffer.from('export {};\n').toString('base64') });
check('contents nested create', r.status === 201);
r = await req('GET', '/api/v3/repos/adaiversen/smoke/contents/src');
check('contents dir listing', r.status === 200 && Array.isArray(r.json) && r.json.length === 1 && r.json[0].name === 'index.ts');

// branches + commits
r = await req('GET', '/api/v3/repos/adaiversen/smoke/branches');
check('branches', r.status === 200 && r.json?.length === 1 && r.json[0].name === 'main');
const mainSha = r.json[0].commit.sha;
r = await req('GET', '/api/v3/repos/adaiversen/smoke/commits');
check('commits list', r.status === 200 && Array.isArray(r.json) && r.json.length === 3, `n=${r.json?.length}`);
r = await req('POST', '/api/v3/repos/adaiversen/smoke/git/refs', { ref: 'refs/heads/feature', sha: mainSha });
check('create branch ref', r.status === 201);
r = await req('GET', '/api/v3/repos/adaiversen/smoke/branches/feature');
check('get branch', r.status === 200 && r.json?.commit?.sha === mainSha);

// labels + issues
r = await req('POST', '/api/v3/repos/adaiversen/smoke/labels', { name: 'bug', color: 'ff0000' });
check('create label', r.status === 201);
r = await req('POST', '/api/v3/repos/adaiversen/smoke/issues', { title: 'bad label issue', labels: ['nope'] });
check('issue bad label 422', r.status === 422);
r = await req('POST', '/api/v3/repos/adaiversen/smoke/issues', { title: 'First issue', body: 'body here', labels: ['bug'] });
check('create issue', r.status === 201 && r.json?.number === 1, `status=${r.status}`);
r = await req('POST', '/api/v3/repos/adaiversen/smoke/issues', { title: 'Second issue' });
check('issue numbers increment', r.status === 201 && r.json?.number === 2);
r = await req('GET', '/api/v3/repos/adaiversen/smoke/issues?state=open&sort=created&direction=asc');
check('list issues asc', r.status === 200 && r.json?.length === 2 && r.json[0].number === 1);
r = await req('PATCH', '/api/v3/repos/adaiversen/smoke/issues/1', { state: 'closed' });
check('close issue', r.status === 200 && r.json?.state === 'closed');
r = await req('POST', '/api/v3/repos/adaiversen/smoke/issues/1/comments', { body: 'a comment' });
check('comment', r.status === 201 && r.json?.id === 1);

// pulls: branch commit via contents, PR, files, merge
r = await req('PUT', '/api/v3/repos/adaiversen/smoke/contents/feature.txt', { message: 'feature work', content: Buffer.from('feature\n').toString('base64'), branch: 'feature' });
check('contents on branch', r.status === 201, `status=${r.status}`);
r = await req('POST', '/api/v3/repos/adaiversen/smoke/pulls', { title: 'Add feature', head: 'feature', base: 'main' });
check('create PR', r.status === 201 && r.json?.number === 3, `status=${r.status} n=${r.json?.number}`);
r = await req('GET', '/api/v3/repos/adaiversen/smoke/pulls/3/files');
check('PR files', r.status === 200 && Array.isArray(r.json) && r.json[0]?.filename === 'feature.txt' && r.json[0]?.status === 'added', JSON.stringify(r.json)?.slice(0, 160));
r = await req('PUT', '/api/v3/repos/adaiversen/smoke/pulls/3/merge', { merge_method: 'squash' });
check('merge PR squash', r.status === 200 && r.json?.merged === true, `status=${r.status} ${r.text.slice(0, 120)}`);
r = await req('GET', '/api/v3/repos/adaiversen/smoke/contents/feature.txt');
check('merged content on main', r.status === 200 && Buffer.from(r.json?.content ?? '', 'base64').toString() === 'feature\n');
r = await req('GET', '/api/v3/repos/adaiversen/smoke/pulls?state=all');
check('pulls state=all', r.status === 200 && r.json?.length === 1 && r.json[0].merged === true);

// pagination: 30 repos
for (let i = 0; i < 30; i += 1) {
  const rr = await req('POST', '/api/v3/user/repos', { name: `page-${i}`, private: true });
  if (rr.status !== 201) { check(`pagination repo ${i}`, false, `status=${rr.status}`); break; }
}
r = await req('GET', '/api/v3/user/repos?per_page=10');
const link = r.headers.get('link') ?? '';
check('pagination link next', r.status === 200 && r.json?.length === 10 && link.includes('rel="next"'), link);
const nextUrl = /<([^>]+)>; rel="next"/.exec(link)?.[1] ?? '';
if (nextUrl) {
  const u = new URL(nextUrl);
  const r2 = await req('GET', `${u.pathname}${u.search}`);
  check('pagination page 2', r2.status === 200 && r2.json?.length === 10);
}

// ---- git CLI round-trip (async spawn: the server under test shares this event loop,
// so a synchronous spawn would deadlock it) ----
const { spawn } = await import('node:child_process');
function gitAsync(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const dir = mkdtempSync(join(tmpdir(), 'forge-smoke-'));
try {
  const git = (args, cwd = dir) => gitAsync(args, cwd);
  let g = await git(['clone', `${BASE}/adaiversen/smoke.git`, 'clone']);
  check('git clone', g.status === 0, (g.stderr ?? '').slice(0, 200));
  writeFileSync(join(dir, 'clone', 'from-git.txt'), 'via git\n');
  g = await git(['-C', 'clone', 'add', '.']);
  g = await git(['-C', 'clone', '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'from git']);
  check('git commit', g.status === 0, (g.stderr ?? '').slice(0, 200));
  g = await git(['-C', 'clone', 'push', 'origin', 'main']);
  check('git push', g.status === 0, (g.stderr ?? '').slice(0, 300));
  r = await req('GET', '/api/v3/repos/adaiversen/smoke/contents/from-git.txt');
  check('pushed file visible via REST', r.status === 200);
  // non-fast-forward must be refused
  g = await git(['clone', `${BASE}/adaiversen/smoke.git`, 'clone2']);
  await git(['-C', 'clone2', 'reset', '--hard', 'HEAD~1']);
  writeFileSync(join(dir, 'clone2', 'other.txt'), 'diverge\n');
  await git(['-C', 'clone2', 'add', '.']);
  await git(['-C', 'clone2', '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'diverge']);
  g = await git(['-C', 'clone2', 'push', 'origin', 'main']);
  check('non-fast-forward refused', g.status !== 0 && (g.stderr ?? '').includes('non-fast-forward'), (g.stderr ?? '').slice(0, 200));
  // shallow clone
  g = await git(['clone', '--depth', '1', `${BASE}/adaiversen/smoke.git`, 'shallow']);
  check('shallow clone', g.status === 0, (g.stderr ?? '').slice(0, 200));
  // annotated tag
  g = await git(['-C', 'clone', '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'tag', '-a', 'v1', '-m', 'version 1']);
  g = await git(['-C', 'clone', 'push', 'origin', 'v1']);
  check('push tag', g.status === 0, (g.stderr ?? '').slice(0, 200));
  g = await git(['clone', `${BASE}/adaiversen/smoke.git`, 'clone3']);
  g = await git(['-C', 'clone3', 'tag', '-l']);
  check('tag round-trips', g.status === 0 && (g.stdout ?? '').includes('v1'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---- GraphQL ----
async function gql(query, variables) {
  const res = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
  return { status: res.status, json: await res.json() };
}
let g = await gql('query { viewer { login } }');
check('gql viewer', g.status === 200 && g.json?.data?.viewer?.login === 'adaiversen', JSON.stringify(g.json)?.slice(0, 120));
g = await gql('query { repository(owner: "adaiversen", name: "smoke") { name nameWithOwner owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }');
check('gql repository', g.status === 200 && g.json?.data?.repository?.nameWithOwner === 'adaiversen/smoke', JSON.stringify(g.json)?.slice(0, 160));
g = await gql('query { Issue: __type(name: "Issue") { fields { name } } }');
check('gql __type Issue', g.status === 200 && (g.json?.data?.Issue?.fields ?? []).some((f) => f.name === 'title'));
g = await gql('query { viewer { login noSuchFieldOnViewer } }');
check('gql unknown field errors', g.status === 200 && Array.isArray(g.json?.errors) && JSON.stringify(g.json.errors).includes('noSuchFieldOnViewer'));
g = await gql('query OpenIssues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }', { owner: 'adaiversen', name: 'smoke', first: 10 });
check('gql open issues desc', g.status === 200 && g.json?.data?.repository?.issues?.nodes?.[0]?.number === 2, JSON.stringify(g.json)?.slice(0, 200));
g = await gql('query { repository(owner: "adaiversen", name: "smoke") { issues(first: 1) { nodes { number } pageInfo { hasNextPage endCursor } } } }');
const cursor = g.json?.data?.repository?.issues?.pageInfo?.endCursor;
check('gql cursor page 1', g.status === 200 && g.json?.data?.repository?.issues?.pageInfo?.hasNextPage === true, JSON.stringify(g.json)?.slice(0, 160));
g = await gql('query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }', { owner: 'adaiversen', name: 'smoke', first: 1, after: cursor });
check('gql cursor page 2 no repeat', g.status === 200 && g.json?.data?.repository?.issues?.nodes?.[0]?.number === 2, JSON.stringify(g.json)?.slice(0, 160));
const repoId = (await gql('query { repository(owner: "adaiversen", name: "smoke") { id } }')).json?.data?.repository?.id;
g = await gql('mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }', { input: { repositoryId: repoId, title: 'GQL issue', body: 'via gql' } });
check('gql createIssue', g.status === 200 && g.json?.data?.createIssue?.issue?.number === 4, JSON.stringify(g.json)?.slice(0, 160));
const issueId = g.json?.data?.createIssue?.issue?.id;
g = await gql('mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }', { input: { issueId } });
check('gql closeIssue', g.status === 200 && g.json?.data?.closeIssue?.issue?.state === 'CLOSED');
g = await gql('query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }', { id: repoId });
check('gql node repository', g.status === 200 && g.json?.data?.node?.nameWithOwner === 'adaiversen/smoke', JSON.stringify(g.json)?.slice(0, 160));
g = await gql('query { repository(owner: "adaiversen", name: "smoke") { pullRequests(first: 5) { nodes { number headRefName baseRefName mergeable state } } } }');
check('gql pullRequests mergeable enum', g.status === 200 && g.json?.data?.repository?.pullRequests?.nodes?.[0]?.mergeable === 'MERGEABLE' && g.json?.data?.repository?.pullRequests?.nodes?.[0]?.state === 'MERGED', JSON.stringify(g.json)?.slice(0, 200));
g = await gql('query { repository(owner: "adaiversen", name: "smoke") { pullRequest(number: 3) { number files(first: 10) { nodes { path } } } } }');
check('gql pullRequest files nodes', g.status === 200 && (g.json?.data?.repository?.pullRequest?.files?.nodes ?? []).some((n) => n.path === 'feature.txt'), JSON.stringify(g.json)?.slice(0, 200));
r = await req('GET', '/api/v3/repos/adaiversen/smoke/commits?sha=feature');
check('commits message exact (no trailing newline)', r.status === 200 && Array.isArray(r.json) && r.json.every((c) => c.commit.message === c.commit.message.replace(/\n+$/, '')) && r.json.some((c) => c.commit.message === 'feature work'));
r = await req('GET', '/api/v3/repos/adaiversen/smoke/commits');
check('commits default branch excludes feature commit', r.status === 200 && Array.isArray(r.json) && !r.json.some((c) => c.commit.message === 'feature work'));
g = await gql('query { repository(owner: "adaiversen", name: "nope") { name } }');
check('gql unknown repo null', g.status === 200 && g.json?.data?.repository === null);
const noAuth = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query { viewer { login } }' }) });
check('gql no token 401', noAuth.status === 401);
// batch: two operations in one body
const batchRes = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers: H, body: JSON.stringify([{ query: 'query { viewer { login } }' }, { query: 'query { repository(owner: "adaiversen", name: "smoke") { name } }' }]) });
const batchJson = await batchRes.json();
check('gql batch', batchRes.status === 200 && Array.isArray(batchJson) && batchJson.length === 2 && batchJson[0]?.data?.viewer?.login === 'adaiversen');

// ---- MCP ----
async function mcp(body, headers = H) {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}
let m = await mcp({ jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: {} });
check('mcp discover', m.status === 200 && Array.isArray(m.json?.result?.supportedVersions) && m.json.result.supportedVersions.includes('2026-07-28'), JSON.stringify(m.json)?.slice(0, 160));
m = await mcp({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
check('mcp initialize', m.status === 200 && m.json?.result?.serverInfo?.name === 'github-core-clone' && m.json?.result?.capabilities?.tools !== undefined);
m = await mcp({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} });
check('mcp tools/list 6 tools', m.status === 200 && Array.isArray(m.json?.result?.tools) && m.json.result.tools.length >= 6);
m = await mcp({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } });
check('mcp create_repo', m.status === 200 && m.json?.result?.isError !== true, JSON.stringify(m.json)?.slice(0, 160));
m = await mcp({ jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo', title: 'MCP issue', body: 'hi' } } });
check('mcp create_issue', m.status === 200 && m.json?.result?.isError !== true);
m = await mcp({ jsonrpc: '2.0', id: 'call-3', method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'mcp-repo', state: 'open' } } });
check('mcp list_issues', m.status === 200 && (m.json?.result?.content?.[0]?.text ?? '').includes('MCP issue'));
m = await mcp({ jsonrpc: '2.0', id: 'call-4', method: 'tools/call', params: { name: 'nope_tool', arguments: {} } });
check('mcp unknown tool -32601', m.status === 200 && (m.json?.error?.code === -32601 || m.json?.error?.code === -32602));
m = await mcp({ jsonrpc: '2.0', id: 'call-5', method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } });
check('mcp missing args isError', m.status === 200 && m.json?.result?.isError === true);
m = await mcp('this is not json');
check('mcp parse error 400/-32700', m.status === 400 && m.json?.error?.code === -32700);
m = await mcp({ jsonrpc: '2.0', id: 'call-6', method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } }, { 'Content-Type': 'application/json' });
check('mcp tools/call no auth 401', m.status === 401);

server.close();
console.log(failures === 0 ? 'ALL SMOKE TESTS PASSED' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
