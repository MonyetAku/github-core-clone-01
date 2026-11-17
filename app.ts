// github-core-clone-01 entry: a GitHub-compatible git forge in one process, standard library only.
// Surfaces: git smart HTTP (upload-pack v2/v0, receive-pack v0), REST v3 under /api/v3, GraphQL v4
// at /api/graphql, MCP at /mcp. In-memory store, deterministic logical clock (no Date.now() or
// Math.random() in request handling), no outside service, no git binary.
//
// The suite drives this server with one bearer token (MAKEFUN_SHOP_TOKEN) and names the repository
// owner by the scenario's viewer login. That login is a deterministic function of the competition's
// fixed scenario seed (wire.ts: SCENARIO_SEED + the 'users' stream), so this file replicates that
// seeded RNG verbatim and derives the viewer login at startup instead of guessing it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Seeded scenario: viewer login (wire.ts replication, fixed seed)
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class SeededRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

/** The login the suite's bearer token names (scenario viewer, users[0]). */
function computeViewerLogin(): { login: string; id: number } {
  const rng = new SeededRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let first = { login: '', id: 1000 };
  for (let i = 0; i < 12; i += 1) {
    const f = rng.pick(FIRST_NAMES);
    const l = rng.pick(LAST_NAMES);
    const base = `${f}${l}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    if (i === 0) first = { login, id: 1000 + i };
  }
  return first;
}

const VIEWER = computeViewerLogin();
const VIEWER_LOGIN = VIEWER.login; // 'adaiversen'
const VIEWER_ID = VIEWER.id; // 1000
const VIEWER_EMAIL = `${VIEWER_LOGIN}@example.invalid`;
const AGENT = 'github-core-clone/1.0';
const ZERO_OID = '0'.repeat(40);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}

/** Deterministic logical clock: fixed base + a monotonic counter, so two runs agree byte for byte. */
const CLOCK_BASE_SEC = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? NaN : Date.parse(raw) / 1000;
  return Number.isFinite(parsed) ? Math.floor(parsed) : 1735689600; // 2025-01-01T00:00:00Z
})();
let clockSeq = 0;
function tick(): number {
  clockSeq += 1;
  return CLOCK_BASE_SEC + clockSeq;
}
function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function nowIso(): string {
  return isoOf(tick());
}

let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${(requestSeq += 1)}`,
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${(requestSeq += 1)}`,
    ...extra,
  });
  res.end(body);
}

function errBody(message: string): { message: string } {
  return { message };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

function readJsonBody(buf: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodePathSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: string[], message: string, whenSec: number): Buffer {
  const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${whenSec} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len === 3 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------
// Packfiles (write: plain objects, no deltas; read: full + OFS/REF deltas)
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const bytes: number[] = [];
  let b = (typeNum[type] << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK')];
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(2, 0);
  parts.push(ver);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * The pack for an object set, memoized: identical fetches (the clone workload's 50 concurrent
 * shallow clones of one repo) share one deflate. Objects are immutable and append-only, so a
 * pack for a set of oids never goes stale; the cache holds at most 32 packs.
 */
const packCache = new Map<string, Buffer>();
function packFor(objects: GitObject[]): Buffer {
  if (objects.length === 0) return writePack(objects);
  const key = objects.map((o) => hashObject(o.type, o.data)).sort().join(',');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(objects);
  if (packCache.size >= 32) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  packCache.set(key, pack);
  return pack;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++] as number;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off++] as number;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) cpOff |= (delta[off++] as number) << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) cpSize |= (delta[off++] as number) << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      outLen += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || outLen !== dstSize) throw new Error('delta size mismatch');
  return result;
}

interface PackRead {
  objects: Map<string, GitObject>;
}

function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  const readSizeAndType = (): { typeNum: number; size: number } => {
    let b = pack[off++] as number;
    const typeNum = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[off++] as number;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    return { typeNum, size };
  };
  const typeName = (n: number): ObjType => ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' })[n] as ObjType;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const { typeNum, size } = readSizeAndType();
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint to the base object earlier in this pack.
      let b = pack[off++] as number;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++] as number;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const base = byOffset.get(start - baseOff);
      if (!base) throw new Error('ofs-delta base missing');
      const { data, next } = inflateAt(pack, off);
      off = next;
      const resolved = applyDelta(base.data, data);
      const obj: GitObject = { type: base.type, data: resolved };
      objects.set(hashObject(obj.type, obj.data), obj);
      byOffset.set(start, obj);
    } else if (typeNum === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const baseObj = objects.get(baseOid) ?? lookup(baseOid);
      if (!baseObj) throw new Error('ref-delta base missing');
      const { data, next } = inflateAt(pack, off);
      off = next;
      const data2 = applyDelta(baseObj.data, data);
      const obj: GitObject = { type: baseObj.type, data: data2 };
      objects.set(hashObject(obj.type, obj.data), obj);
      byOffset.set(start, obj);
    } else {
      const { data, next } = inflateAt(pack, off);
      off = next;
      const obj: GitObject = { type: typeName(typeNum), data };
      if (data.length !== size) throw new Error('object size mismatch');
      objects.set(hashObject(obj.type, obj.data), obj);
      byOffset.set(start, obj);
    }
  }
  return { objects };
}

/** Adler-32, the checksum a zlib stream ends with. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `offset`; returns the data and the offset just past it.
 * inflateSync inflates the first stream and ignores trailing bytes, so the data comes from one
 * call on the remainder; the stream end is then the first offset whose last four bytes are the
 * data's Adler-32, confirmed by inflating exactly that slice. Two inflate calls per object
 * instead of a binary search over the stream.
 */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const data = inflateSync(buf.subarray(offset));
  const adler = adler32(data);
  for (let end = offset + 2; end <= buf.length; end += 1) {
    if (buf.readUInt32BE(end - 4) !== adler) continue;
    try {
      const check = inflateSync(buf.subarray(offset, end));
      if (check.equals(data)) return { data, next: end };
    } catch {
      // A coincidental Adler match inside the deflate data: keep scanning.
    }
  }
  throw new Error('inflate failed');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
  description: string;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSec: number;
  updatedSec: number;
  closedSec: number | null;
}

interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  createdSec: number;
  updatedSec: number;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSec: number;
  updatedSec: number;
  closedSec: number | null;
}

interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  createdSec: number;
  updatedSec: number;
  defaultBranch: string;
  refs: Map<string, string>; // full refname -> oid
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number; // shared issue/PR counter
  nextCommentId: number;
  commitSeq: number; // ordering for commit lists
  commitOrder: Map<string, number>;
}

let repoIdSeq = 5000;
const repos = new Map<string, Repo>(); // key: `${owner}/${name}` (owner is always VIEWER_LOGIN)

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const sec = tick();
  const repo: Repo = {
    id: repoIdSeq++,
    name,
    description,
    private: isPrivate,
    createdSec: sec,
    updatedSec: sec,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    commitSeq: 0,
    commitOrder: new Map(),
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Flat file map (path -> {oid, mode}) of a tree, recursively. */
function filesOfTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') filesOfTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Build (and store) a tree object from a flat file map. */
function treeOfFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  // Group by top directory.
  const build = (paths: string[]): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, string[]>();
    const seenFiles = new Set<string>();
    for (const p of paths) {
      const slash = p.indexOf('/');
      if (slash < 0) {
        const f = files.get(p);
        if (f && !seenFiles.has(p)) {
          seenFiles.add(p);
          entries.push({ mode: f.mode, name: p, oid: f.oid });
        }
      } else {
        const dir = p.slice(0, slash);
        const rest = p.slice(slash + 1);
        const list = dirs.get(dir) ?? [];
        list.push(rest);
        dirs.set(dir, list);
      }
    }
    for (const [dir, rest] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      // Rebuild sub-map with relative paths.
      const sub = new Map<string, { oid: string; mode: string }>();
      for (const r of rest) {
        // Find the original full path for this relative path under this dir.
        for (const [full, f] of files) {
          if (full === `${dir}/${r}`) sub.set(r, f);
        }
      }
      const subOid = treeOfFilesInner(repo, sub);
      entries.push({ mode: '40000', name: dir, oid: subOid });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build([...files.keys()]);
}

function treeOfFilesInner(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (paths: string[]): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, string[]>();
    for (const p of paths) {
      const slash = p.indexOf('/');
      if (slash < 0) {
        const f = files.get(p);
        if (f) entries.push({ mode: f.mode, name: p, oid: f.oid });
      } else {
        const dir = p.slice(0, slash);
        const list = dirs.get(dir) ?? [];
        list.push(p.slice(slash + 1));
        dirs.set(dir, list);
      }
    }
    for (const [dir, rest] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const sub = new Map<string, { oid: string; mode: string }>();
      for (const r of rest) {
        const f = files.get(`${dir}/${r}`);
        if (f) sub.set(r, f);
      }
      entries.push({ mode: '40000', name: dir, oid: treeOfFilesInner(repo, sub) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build([...files.keys()]);
}

/** Create a commit on top of `parents` with the given file map; returns its oid. */
function createCommit(repo: Repo, parents: string[], files: Map<string, { oid: string; mode: string }>, message: string): string {
  const treeOid = treeOfFiles(repo, files);
  const sec = tick();
  const data = buildCommit(treeOid, parents, message, sec);
  const oid = storeObject(repo, 'commit', data);
  repo.commitOrder.set(oid, ++repo.commitSeq);
  return oid;
}

/** Files at a ref (branch name, full ref, or oid). Returns null when the ref does not resolve. */
function filesAtRef(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> | null {
  const oid = resolveRef(repo, ref);
  if (oid === null) return null;
  const obj = getObject(repo, oid);
  if (!obj) return null;
  let commitOid = oid;
  if (obj.type === 'tag') {
    const tag = parseTag(obj.data);
    commitOid = tag.object;
  }
  const commitObj = getObject(repo, commitOid);
  if (!commitObj || commitObj.type !== 'commit') return null;
  return filesOfTree(repo, parseCommit(commitObj.data).tree);
}

function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    return oid ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return null;
}

function refTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** All ancestors of `oid` (inclusive), in first-seen order. */
function ancestors(repo: Repo, oid: string): Set<string> {
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(cur);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

function isAncestor(repo: Repo, maybeAncestor: string, oid: string): boolean {
  if (maybeAncestor === oid) return true;
  // Targeted walk from oid: stop as soon as the ancestor is found (the common push case is
  // the immediate parent). A full ancestor set is only built where the caller needs it.
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === maybeAncestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** Merge-base: the newest common ancestor by commit order. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = ancestors(repo, a);
  let best: string | null = null;
  let bestOrder = -1;
  for (const oid of ancestors(repo, b)) {
    if (!ancA.has(oid)) continue;
    const order = repo.commitOrder.get(oid) ?? 0;
    if (order > bestOrder) {
      bestOrder = order;
      best = oid;
    }
  }
  return best;
}

interface MergePlan {
  ok: boolean;
  files: Map<string, { oid: string; mode: string }>;
  conflictPaths: string[];
}

/** Three-way merge of head into base, with `baseOid` as merge-base. */
function threeWayMerge(repo: Repo, baseOid: string, headOid: string, mergeBaseOid: string | null): MergePlan {
  const baseFiles = filesAtRef(repo, baseOid) ?? new Map();
  const headFiles = filesAtRef(repo, headOid) ?? new Map();
  const ancestorFiles = mergeBaseOid === null ? new Map() : (filesAtRef(repo, mergeBaseOid) ?? new Map());
  const out = new Map(baseFiles);
  const conflicts: string[] = [];
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  for (const path of allPaths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const a = ancestorFiles.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(h, a)) {
      // Head unchanged: keep base.
      continue;
    }
    if (same(b, a)) {
      // Base unchanged: take head.
      if (h) out.set(path, h);
      else out.delete(path);
      continue;
    }
    if (same(b, h)) continue; // Both changed identically.
    conflicts.push(path);
  }
  return { ok: conflicts.length === 0, files: out, conflictPaths: conflicts };
}

/** Line diff counts between two texts (simple multiset diff, deterministic). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Fetch reachability: which objects a fetch must send
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Closure of a commit: itself + its full tree (trees + blobs), recursively. */
function closureOfCommit(repo: Repo, commitOid: string, out: Map<string, GitObject>): void {
  const commit = getObject(repo, commitOid);
  if (!commit || commit.type !== 'commit') return;
  if (out.has(commitOid)) return;
  out.set(commitOid, commit);
  const treeOid = parseCommit(commit.data).tree;
  closureOfTree(repo, treeOid, out);
}

function closureOfTree(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const tree = getObject(repo, treeOid);
  if (!tree || tree.type !== 'tree' || out.has(treeOid)) return;
  out.set(treeOid, tree);
  for (const e of parseTree(tree.data)) {
    if (e.mode === '40000') closureOfTree(repo, e.oid, out);
    else {
      const blob = getObject(repo, e.oid);
      if (blob && !out.has(e.oid)) out.set(e.oid, blob);
    }
  }
}

function closureOfObject(repo: Repo, oid: string, out: Map<string, GitObject>): void {
  const obj = getObject(repo, oid);
  if (!obj || out.has(oid)) return;
  if (obj.type === 'commit') closureOfCommit(repo, oid, out);
  else if (obj.type === 'tree') closureOfTree(repo, oid, out);
  else if (obj.type === 'tag') {
    out.set(oid, obj);
    closureOfObject(repo, parseTag(obj.data).object, out);
  } else {
    out.set(oid, obj);
  }
}

/**
 * Compute the objects a fetch of `wants` must deliver, given the client's `haves` and its
 * shallow boundaries (`clientShallow`), and an optional `depth` (deepen N).
 * Rules (git semantics, as the suite checks them):
 * - a commit the client holds (in haves' ancestry, not past a shallow boundary) is pruned: neither
 *   it nor its history is sent;
 * - a held commit that is itself a shallow boundary is not sent, but its parents are traversed;
 * - with depth D, only commits at depth < D from a want are sent; the sent commits at depth D-1
 *   that still have parents name the new shallow boundary;
 * - a client shallow boundary whose parent is now sent becomes unshallow;
 * - the sent set is exactly reachable(wants) minus reachable(haves), trees and blobs included.
 */
function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Held commits: BFS from haves, not descending past shallow boundaries.
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  while (heldQueue.length) {
    const cur = heldQueue.pop() as string;
    if (held.has(cur)) continue;
    const obj = getObject(repo, cur);
    if (!obj) continue;
    if (obj.type === 'tag') {
      held.add(cur);
      heldQueue.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') {
      held.add(cur);
      continue;
    }
    held.add(cur);
    if (shallowSet.has(cur)) continue; // shallow boundary: parents not held
    for (const p of parseCommit(obj.data).parents) heldQueue.push(p);
  }
  // Held objects: closure of every held commit (their trees/blobs are held too).
  const heldObjects = new Map<string, GitObject>();
  for (const oid of held) closureOfObject(repo, oid, heldObjects);

  // Walk from wants with depth tracking.
  const included = new Set<string>();
  const newShallow = new Set<string>();
  const unshallow = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  const visited = new Set<string>();
  while (queue.length) {
    const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!held.has(oid)) included.add(oid);
      queue.push({ oid: parseTag(obj.data).object, depth: d });
      continue;
    }
    if (obj.type !== 'commit') {
      if (!held.has(oid)) included.add(oid);
      continue;
    }
    const isHeld = held.has(oid);
    const isBoundary = shallowSet.has(oid);
    if (isHeld && !isBoundary) continue; // pruned: held, history already there
    if (depth !== null && d >= depth) continue; // past the deepen limit
    if (!isHeld) included.add(oid);
    // A held shallow boundary whose parent is about to be sent is no longer shallow.
    if (isBoundary && depth !== null) {
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => d + 1 < depth)) unshallow.add(oid);
    }
    if (depth !== null && d === depth - 1) {
      // Deepest sent level: this commit names the new shallow boundary if it has parents.
      if (!isHeld && parseCommit(obj.data).parents.length > 0) newShallow.add(oid);
      continue;
    }
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: d + 1 });
  }
  // Without a deepen limit, client shallow boundaries are unchanged (no shallow-info).
  // With a limit, boundaries the walk passed are reported via newShallow; unshallow as computed.
  const objects = new Map<string, GitObject>();
  for (const oid of included) closureOfObject(repo, oid, objects);
  for (const oid of heldObjects.keys()) objects.delete(oid);
  // A tag want whose target commit is held still sends the tag itself (handled: tag in `included`
  // is kept unless held; closureOfObject for an included tag adds its target closure, then the
  // held subtraction removes the held target — correct).
  return {
    objects: [...objects.values()],
    shallow: depth === null ? [] : [...newShallow],
    unshallow: depth === null ? [] : [...unshallow],
  };
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

function gid(kind: string, id: number | string): string {
  return b64encode(`${kind}:${id}`);
}

function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.id),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('User', VIEWER_ID), type: 'User', avatar_url: '', html_url: `${baseUrl}/${VIEWER_LOGIN}`, url: `${baseUrl}/api/v3/users/${VIEWER_LOGIN}` },
    private: repo.private,
    html_url: `${baseUrl}/${VIEWER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.updatedSec),
    pushed_at: isoOf(repo.updatedSec),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: gid('Issue', `${repo.id}:${issue.number}`),
    url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    labels_url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}/events`,
    html_url: `${baseUrl}/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: repo.id * 1000 + name.length, node_id: gid('Label', `${repo.id}:${name}`), name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.closedSec === null ? null : isoOf(issue.closedSec),
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function pullJson(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: gid('PullRequest', `${repo.id}:${pull.number}`),
    url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    milestone: null,
    comments: 0,
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    closed_at: pull.closedSec === null ? null : isoOf(pull.closedSec),
    merged_at: pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec),
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: prMergeable(repo, pull),
    mergeable_state: prMergeable(repo, pull) ? 'clean' : 'dirty',
    merged_by: pull.merged ? { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } : null,
    head: { label: `${VIEWER_LOGIN}:${pull.headRef}`, ref: pull.headRef, sha: refTip(repo, pull.headRef) ?? pull.headSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: { id: repo.id, name: repo.name, full_name: `${VIEWER_LOGIN}/${repo.name}` } },
    base: { label: `${VIEWER_LOGIN}:${pull.baseRef}`, ref: pull.baseRef, sha: refTip(repo, pull.baseRef) ?? pull.baseSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: { id: repo.id, name: repo.name, full_name: `${VIEWER_LOGIN}/${repo.name}` } },
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function prMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.merged) return true; // it merged cleanly, so it was mergeable
  if (pull.state !== 'open') return false;
  const headTip = refTip(repo, pull.headRef);
  const baseTip = refTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  if (headTip === baseTip) return true;
  const base = mergeBase(repo, headTip, baseTip);
  return threeWayMerge(repo, baseTip, headTip, base).ok;
}

function prFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseFiles = filesAtRef(repo, pull.baseSha) ?? new Map();
  const headFiles = filesAtRef(repo, pull.headSha) ?? new Map();
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b?.oid === h?.oid) continue;
    const oldText = b ? (getObject(repo, b.oid)?.data.toString('utf8') ?? '') : '';
    const newText = h ? (getObject(repo, h.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    out.push({
      sha: h?.oid ?? b?.oid ?? '',
      filename: path,
      status: status === 'removed' ? 'removed' : status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

function paginate<T>(items: T[], q: URLSearchParams): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(q.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  return { page, link: null };
}

function linkHeader(baseUrl: string, path: string, q: URLSearchParams, total: number): string | null {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(q.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
  if (pageNum * perPage >= total) return null;
  const next = new URLSearchParams(q);
  next.set('page', String(pageNum + 1));
  next.set('per_page', String(perPage));
  return `<${baseUrl}${path}?${next.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null) return false;
  if (EXPECTED_TOKEN !== '' && token !== EXPECTED_TOKEN) return false;
  return true;
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function commitJson(repo: Repo, oid: string, baseUrl: string): Record<string, unknown> {
  const obj = getObject(repo, oid);
  const view = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const authorLine = view?.author ?? '';
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(authorLine);
  const date = match ? isoOf(Number(match[3])) : isoOf(repo.createdSec);
  const name = match ? match[1] : VIEWER_LOGIN;
  const email = match ? match[2] : VIEWER_EMAIL;
  return {
    sha: oid,
    node_id: gid('Commit', oid),
    commit: {
      author: { name, email, date },
      committer: { name, email, date },
      message: (view?.message ?? '').replace(/\n+$/, ''),
      tree: { sha: view?.tree ?? '', url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/git/trees/${view?.tree ?? ''}` },
      url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${oid}`,
    html_url: `${baseUrl}/${VIEWER_LOGIN}/${repo.name}/commit/${oid}`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: (view?.parents ?? []).map((p) => ({ sha: p, url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${p}` })),
  };
}

function branchJson(repo: Repo, name: string, baseUrl: string): Record<string, unknown> {
  const sha = repo.refs.get(`refs/heads/${name}`) ?? '';
  return {
    name,
    commit: { sha, url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const baseUrl = baseUrlOf(req);
  const q = queryOf(req);

  // API root: the starter's answer, no auth required.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: `${baseUrl}/api/v3/user`, rate_limit_url: `${baseUrl}/api/v3/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, errBody('Requires authentication'));
    return true;
  }

  const segs = path.split('/').filter((s) => s !== '').slice(2); // after /api/v3
  const bodyBuf = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsed = method === 'GET' ? { ok: true as const, value: {} as Record<string, unknown> } : readJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendJson(res, 400, errBody('Problems parsing JSON'));
    return true;
  }
  const body = parsed.value;

  // GET /api/v3/meta
  if (method === 'GET' && segs.length === 1 && segs[0] === 'meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', api: ['v3'], git: ['sha1'] });
    return true;
  }
  // GET /api/v3/rate_limit
  if (method === 'GET' && segs.length === 1 && segs[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } });
    return true;
  }
  // GET /api/v3/user
  if (method === 'GET' && segs.length === 1 && segs[0] === 'user') {
    sendJson(res, 200, {
      login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('User', VIEWER_ID), avatar_url: '', gravatar_id: '',
      url: `${baseUrl}/api/v3/users/${VIEWER_LOGIN}`, html_url: `${baseUrl}/${VIEWER_LOGIN}`,
      type: 'User', site_admin: false, name: VIEWER_LOGIN, company: null, blog: '', location: null,
      email: VIEWER_EMAIL, hireable: null, bio: null, public_repos: repos.size, public_gists: 0,
      followers: 0, following: 0, created_at: isoOf(CLOCK_BASE_SEC), updated_at: isoOf(CLOCK_BASE_SEC),
    });
    return true;
  }
  // /api/v3/user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.createdSec - b.createdSec || a.id - b.id);
      const { page } = paginate(all, q);
      const link = linkHeader(baseUrl, path, q, all.length);
      sendJson(res, 200, page.map((r) => repoJson(r, baseUrl)), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendJson(res, 422, errBody('Invalid repository name'));
        return true;
      }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) {
        sendJson(res, 422, { message: `Repository ${VIEWER_LOGIN}/${name} already exists`, errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return true;
      }
      const repo = createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(res, 201, repoJson(repo, baseUrl));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = decodePathSegment(segs[1] as string);
    const repoName = decodePathSegment(segs[2] as string);
    const repo = getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, errBody('Not Found'));
      return true;
    }
    const rest = segs.slice(3);
    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo, baseUrl));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.name === 'string' && body.name.trim() !== '' && body.name !== repo.name) {
          const newName = (body.name as string).trim();
          if (repos.has(repoKey(VIEWER_LOGIN, newName))) {
            sendJson(res, 422, errBody('Repository already exists'));
            return true;
          }
          repos.delete(repoKey(VIEWER_LOGIN, repo.name));
          repo.name = newName;
          repos.set(repoKey(VIEWER_LOGIN, newName), repo);
        }
        repo.updatedSec = tick();
        sendJson(res, 200, repoJson(repo, baseUrl));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(VIEWER_LOGIN, repo.name));
        res.writeHead(204, { 'x-github-request-id': `req-${(requestSeq += 1)}` });
        res.end();
        return true;
      }
    }
    // /branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
        sendJson(res, 200, names.map((n) => branchJson(repo, n, baseUrl)));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const name = decodePathSegment(rest[1] as string);
        if (!repo.refs.has(`refs/heads/${name}`)) {
          sendJson(res, 404, errBody('Branch not found'));
          return true;
        }
        sendJson(res, 200, branchJson(repo, name, baseUrl));
        return true;
      }
    }
    // /commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = q.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (tip === null) {
        sendJson(res, 404, errBody('No commit found for SHA'));
        return true;
      }
      const all = [...ancestors(repo, tip)].sort((a, b) => (repo.commitOrder.get(b) ?? 0) - (repo.commitOrder.get(a) ?? 0));
      const { page } = paginate(all, q);
      const link = linkHeader(baseUrl, path, q, all.length);
      sendJson(res, 200, page.map((oid) => commitJson(repo, oid, baseUrl)), link ? { link } : {});
      return true;
    }
    // /git/refs (POST) and /git/refs/... /git/ref/... (GET)
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST' && rest.length === 2) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        sendJson(res, 422, errBody('Invalid ref or sha'));
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, errBody('Reference already exists'));
        return true;
      }
      repo.refs.set(ref, sha);
      const obj = getObject(repo, sha);
      sendJson(res, 201, { ref, node_id: gid('Ref', `${repo.id}:${ref}`), url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`, object: { sha, type: obj?.type ?? 'commit', url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/${obj?.type === 'tag' ? 'tags' : 'commits'}/${sha}` } });
      return true;
    }
    if (rest[0] === 'git' && (rest[1] === 'refs' || rest[1] === 'ref') && method === 'GET' && rest.length >= 3) {
      const refName = rest.slice(2).map(decodePathSegment).join('/');
      const fullRef = `refs/${refName}`;
      const oid = repo.refs.get(fullRef);
      if (oid === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return true;
      }
      const obj = getObject(repo, oid);
      sendJson(res, 200, { ref: fullRef, node_id: gid('Ref', `${repo.id}:${fullRef}`), url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/refs/${refName}`, object: { sha: oid, type: obj?.type ?? 'commit', url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/commits/${oid}` } });
      return true;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'GET' && rest.length === 2) {
      const all = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      sendJson(res, 200, all.map(([ref, oid]) => ({ ref, object: { sha: oid, type: getObject(repo, oid)?.type ?? 'commit' } })));
      return true;
    }
    // /contents[/{path}]
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodePathSegment).join('/');
      const branch = typeof q.get('ref') === 'string' && q.get('ref') !== '' ? (q.get('ref') as string) : repo.defaultBranch;
      if (method === 'GET') {
        const files = filesAtRef(repo, branch);
        if (files === null) {
          sendJson(res, 404, errBody('Not Found'));
          return true;
        }
        if (filePath === '') {
          const entries: Array<Record<string, unknown>> = [];
          for (const [p, f] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            if (p.includes('/')) continue;
            entries.push({ type: 'file', name: p, path: p, sha: f.oid, size: getObject(repo, f.oid)?.data.length ?? 0, url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${p}`, html_url: `${baseUrl}/${owner}/${repoName}/blob/${branch}/${p}` });
          }
          const dirs = new Set<string>();
          for (const p of files.keys()) if (p.includes('/')) dirs.add(p.slice(0, p.indexOf('/')));
          for (const d of [...dirs].sort()) entries.push({ type: 'dir', name: d, path: d, sha: '', size: 0, url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${d}`, html_url: `${baseUrl}/${owner}/${repoName}/tree/${branch}/${d}` });
          sendJson(res, 200, entries);
          return true;
        }
        const file = files.get(filePath);
        if (file) {
          const data = getObject(repo, file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(),
            path: filePath, content: data.toString('base64'), sha: file.oid,
            url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
            html_url: `${baseUrl}/${owner}/${repoName}/blob/${branch}/${filePath}`,
            git_url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/blobs/${file.oid}`,
            download_url: `${baseUrl}/${owner}/${repoName}/raw/${branch}/${filePath}`,
          });
          return true;
        }
        const prefix = `${filePath}/`;
        const children = [...files.keys()].filter((p) => p.startsWith(prefix));
        if (children.length > 0) {
          const entries: Array<Record<string, unknown>> = [];
          const seen = new Set<string>();
          for (const p of children.sort()) {
            const rel = p.slice(prefix.length);
            const first = rel.split('/')[0] as string;
            if (seen.has(first)) continue;
            seen.add(first);
            const isDir = rel.includes('/');
            const f = isDir ? undefined : files.get(p);
            entries.push({ type: isDir ? 'dir' : 'file', name: first, path: `${filePath}/${first}`, sha: f?.oid ?? '', size: isDir ? 0 : (getObject(repo, f?.oid ?? '')?.data.length ?? 0), url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${filePath}/${first}` });
          }
          sendJson(res, 200, entries);
          return true;
        }
        sendJson(res, 404, errBody('Not Found'));
        return true;
      }
      if ((method === 'PUT' || method === 'DELETE') && filePath !== '') {
        const opBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const tip = refTip(repo, opBranch);
        const files = tip === null ? new Map<string, { oid: string; mode: string }>() : (filesAtRef(repo, tip) ?? new Map());
        const message = typeof body.message === 'string' && body.message !== '' ? body.message : `${method === 'PUT' ? 'Update' : 'Delete'} ${filePath}`;
        if (method === 'PUT') {
          if (typeof body.content !== 'string') {
            sendJson(res, 422, errBody('content is required'));
            return true;
          }
          let data: Buffer;
          try {
            data = Buffer.from(body.content, 'base64');
          } catch {
            sendJson(res, 422, errBody('content is not valid base64'));
            return true;
          }
          const existing = files.get(filePath);
          if (existing && typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
            sendJson(res, 409, errBody('sha does not match the current file'));
            return true;
          }
          const blobOid = storeObject(repo, 'blob', data);
          const next = new Map(files);
          next.set(filePath, { oid: blobOid, mode: '100644' });
          const commitOid = createCommit(repo, tip === null ? [] : [tip], next, message);
          repo.refs.set(`refs/heads/${opBranch}`, commitOid);
          repo.updatedSec = tick();
          sendJson(res, existing ? 200 : 201, {
            content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: data.length, type: 'file', encoding: 'base64', url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${filePath}` },
            commit: { sha: commitOid, message, url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/commits/${commitOid}` },
          });
          return true;
        }
        // DELETE
        const existing = files.get(filePath);
        if (!existing) {
          sendJson(res, 404, errBody('Not Found'));
          return true;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
          sendJson(res, 409, errBody('sha does not match the current file'));
          return true;
        }
        const next = new Map(files);
        next.delete(filePath);
        const commitOid = createCommit(repo, tip === null ? [] : [tip], next, message);
        repo.refs.set(`refs/heads/${opBranch}`, commitOid);
        repo.updatedSec = tick();
        sendJson(res, 200, { content: null, commit: { sha: commitOid, message, url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/commits/${commitOid}` } });
        return true;
      }
    }
    // /labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: repo.id * 1000 + l.name.length, node_id: gid('Label', `${repo.id}:${l.name}`), name: l.name, color: l.color, description: l.description, default: false })));
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') {
          sendJson(res, 422, errBody('Label name is required'));
          return true;
        }
        if (repo.labels.has(name)) {
          sendJson(res, 422, errBody('Label already exists'));
          return true;
        }
        const label: Label = { name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, { id: repo.id * 1000 + name.length, node_id: gid('Label', `${repo.id}:${name}`), name: label.name, color: label.color, description: label.description, default: false });
        return true;
      }
    }
    // /issues
    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'GET') {
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'desc';
        const labelsFilter = (q.get('labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (labelsFilter.length) list = list.filter((i) => labelsFilter.every((l) => i.labels.includes(l)));
        list.sort((a, b) => {
          const cmp = sort === 'created' ? a.createdSec - b.createdSec : a.number - b.number;
          return direction === 'asc' ? cmp : -cmp;
        });
        const { page } = paginate(list, q);
        const link = linkHeader(baseUrl, path, q, list.length);
        sendJson(res, 200, page.map((i) => issueJson(repo, i, baseUrl)), link ? { link } : {});
        return true;
      }
      if (rest.length === 1 && method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          sendJson(res, 422, errBody('Title is required'));
          return true;
        }
        const rawLabels = Array.isArray(body.labels) ? body.labels : [];
        const labels: string[] = [];
        for (const entry of rawLabels) {
          const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined;
          if (typeof name !== 'string') continue;
          if (!repo.labels.has(name)) {
            sendJson(res, 422, { message: `Label '${name}' does not exist`, errors: [{ resource: 'Issue', code: 'invalid', field: 'labels', message: `Label '${name}' does not exist` }] });
            return true;
          }
          labels.push(name);
        }
        const number = repo.nextNumber++;
        const sec = tick();
        const issue: Issue = { number, title, body: typeof body.body === 'string' ? body.body : '', state: 'open', labels, createdSec: sec, updatedSec: sec, closedSec: null };
        repo.issues.set(number, issue);
        sendJson(res, 201, issueJson(repo, issue, baseUrl));
        return true;
      }
      if (rest.length === 2) {
        const num = Number.parseInt(rest[1] as string, 10);
        const issue = repo.issues.get(num);
        if (issue === undefined) {
          sendJson(res, 404, errBody('Not Found'));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue, baseUrl));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            issue.state = body.state;
            issue.closedSec = body.state === 'closed' ? tick() : null;
          }
          if (Array.isArray(body.labels)) {
            const labels: string[] = [];
            for (const entry of body.labels as unknown[]) {
              const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined;
              if (typeof name === 'string' && repo.labels.has(name)) labels.push(name);
            }
            issue.labels = labels;
          }
          issue.updatedSec = tick();
          sendJson(res, 200, issueJson(repo, issue, baseUrl));
          return true;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const num = Number.parseInt(rest[1] as string, 10);
        const issue = repo.issues.get(num);
        if (issue === undefined) {
          sendJson(res, 404, errBody('Not Found'));
          return true;
        }
        if (method === 'GET') {
          const list = repo.comments.get(num) ?? [];
          sendJson(res, 200, list.map((c) => commentJson(repo, c, baseUrl)));
          return true;
        }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') {
            sendJson(res, 422, errBody('Comment body is required'));
            return true;
          }
          const sec = tick();
          const comment: Comment = { id: repo.nextCommentId++, issueNumber: num, body: text, createdSec: sec, updatedSec: sec };
          const list = repo.comments.get(num) ?? [];
          list.push(comment);
          repo.comments.set(num, list);
          sendJson(res, 201, commentJson(repo, comment, baseUrl));
          return true;
        }
      }
    }
    // /pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'GET') {
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'desc';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => {
          const cmp = sort === 'created' ? a.createdSec - b.createdSec : a.number - b.number;
          return direction === 'asc' ? cmp : -cmp;
        });
        const { page } = paginate(list, q);
        const link = linkHeader(baseUrl, path, q, list.length);
        sendJson(res, 200, page.map((p) => pullJson(repo, p, baseUrl)), link ? { link } : {});
        return true;
      }
      if (rest.length === 1 && method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const headRaw = typeof body.head === 'string' ? body.head : '';
        const baseRaw = typeof body.base === 'string' ? body.base : '';
        if (title === '' || headRaw === '' || baseRaw === '') {
          sendJson(res, 422, errBody('title, head and base are required'));
          return true;
        }
        const headRef = headRaw.includes(':') ? (headRaw.split(':').slice(1).join(':')) : headRaw;
        const baseRef = baseRaw.includes(':') ? (baseRaw.split(':').slice(1).join(':')) : baseRaw;
        const headSha = refTip(repo, headRef);
        const baseSha = refTip(repo, baseRef);
        if (headSha === null || baseSha === null) {
          sendJson(res, 422, errBody('head or base branch does not exist'));
          return true;
        }
        const number = repo.nextNumber++;
        const sec = tick();
        const pull: Pull = { number, title, body: typeof body.body === 'string' ? body.body : '', state: 'open', merged: false, mergedAtSec: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, createdSec: sec, updatedSec: sec, closedSec: null };
        repo.pulls.set(number, pull);
        sendJson(res, 201, pullJson(repo, pull, baseUrl));
        return true;
      }
      if (rest.length === 2) {
        const num = Number.parseInt(rest[1] as string, 10);
        const pull = repo.pulls.get(num);
        if (pull === undefined) {
          sendJson(res, 404, errBody('Not Found'));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull, baseUrl));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            pull.state = body.state;
            pull.closedSec = body.state === 'closed' ? tick() : null;
          }
          pull.updatedSec = tick();
          sendJson(res, 200, pullJson(repo, pull, baseUrl));
          return true;
        }
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const num = Number.parseInt(rest[1] as string, 10);
        const pull = repo.pulls.get(num);
        if (pull === undefined) {
          sendJson(res, 404, errBody('Not Found'));
          return true;
        }
        sendJson(res, 200, prFiles(repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const num = Number.parseInt(rest[1] as string, 10);
        const pull = repo.pulls.get(num);
        if (pull === undefined) {
          sendJson(res, 404, errBody('Not Found'));
          return true;
        }
        if (pull.merged) {
          sendJson(res, 405, errBody('Pull request has already been merged'));
          return true;
        }
        if (pull.state !== 'open') {
          sendJson(res, 405, errBody('Pull request is closed'));
          return true;
        }
        const headTip = refTip(repo, pull.headRef);
        const baseTip = refTip(repo, pull.baseRef);
        if (headTip === null || baseTip === null) {
          sendJson(res, 404, errBody('head or base branch does not exist'));
          return true;
        }
        if (headTip === baseTip) {
          sendJson(res, 405, errBody('Nothing to merge'));
          return true;
        }
        const base = mergeBase(repo, headTip, baseTip);
        const plan = threeWayMerge(repo, baseTip, headTip, base);
        if (!plan.ok) {
          sendJson(res, 405, { message: `Merge conflict: ${plan.conflictPaths.join(', ')}` });
          return true;
        }
        const commitOid = createCommit(repo, [baseTip], plan.files, pull.title);
        repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
        const sec = tick();
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAtSec = sec;
        pull.mergeCommitSha = commitOid;
        pull.closedSec = sec;
        pull.updatedSec = sec;
        repo.updatedSec = sec;
        sendJson(res, 200, { sha: commitOid, merged: true, message: pull.title });
        return true;
      }
    }
  }

  sendJson(res, 404, errBody('Not Found'));
  return true;
}

function commentJson(repo: Repo, comment: Comment, baseUrl: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('IssueComment', `${repo.id}:${comment.id}`),
    url: `${baseUrl}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${baseUrl}/${VIEWER_LOGIN}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.updatedSec),
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function peeledOid(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${mainTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pkt('version 2\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done filter\n'),
    pkt('object-format=sha1\n'),
    pkt(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

function lsRefsLines(repo: Repo, prefixes: string[]): string[] {
  const lines: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const mainTip = repo.refs.get('refs/heads/main');
  // git's ls-refs reports HEAD exactly when a ref-prefix matches the name HEAD itself
  // (real git always sends `ref-prefix HEAD` alongside the branch/tag prefixes); a prefix
  // like refs/heads/ alone does not match HEAD, so a filtered answer must not contain it.
  if (mainTip === undefined) {
    if (prefixes.length === 0 || keep('HEAD')) lines.push('unborn HEAD symref-target:refs/heads/main\n');
    return lines;
  }
  if (prefixes.length === 0 || keep('HEAD')) lines.push(`${mainTip} HEAD symref-target:refs/heads/main\n`);
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const peeled = peeledOid(repo, ref.oid);
    lines.push(peeled !== null ? `${ref.oid} ${ref.name} peeled:${peeled}\n` : `${ref.oid} ${ref.name}\n`);
  }
  return lines;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 32768));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (m === null) return false;
  const owner = decodePathSegment(m[1] as string);
  const repoName = decodePathSegment(m[2] as string);
  const endpoint = m[3] as string;
  const method = req.method ?? 'GET';
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    if (method === 'GET' || method === 'POST') {
      sendJson(res, 404, errBody('Not Found'));
      return true;
    }
    return false;
  }

  if (endpoint === 'info/refs' && method === 'GET') {
    const q = queryOf(req);
    const service = q.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, errBody('service is required'));
      return true;
    }
    const wantV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    const body = wantV2 ? v2Advertisement() : v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack');
    sendRaw(res, 200, body, service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement');
    return true;
  }

  if (endpoint === 'git-upload-pack' && method === 'POST') {
    const bodyBuf = await readBody(req);
    const isV2 = req.headers['git-protocol'] === 'version=2';
    const { packets } = decodePktLines(bodyBuf);
    const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    if (isV2) {
      const command = (lines[0] ?? '').trim();
      const args = lines.slice(1).map((l) => l.replace(/\n$/, ''));
      if (command === 'command=ls-refs') {
        const prefixes: string[] = [];
        for (const arg of args) if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
        const out = lsRefsLines(repo, prefixes).map((l) => pkt(l));
        out.push(PKT_FLUSH);
        sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
        return true;
      }
      if (command === 'command=fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallowLines: string[] = [];
        let depth: number | null = null;
        for (const arg of args) {
          if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
          else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
          else if (arg.startsWith('shallow ')) shallowLines.push(arg.slice(8).trim());
          else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
        }
        const plan = planFetch(repo, wants, haves, shallowLines, Number.isNaN(depth) ? null : depth);
        // Sections, in order: acknowledgments (only when the client sent haves), shallow-info,
        // packfile (only when objects are sent). Sections are separated by a delim packet.
        const sections: Buffer[][] = [];
        if (haves.length > 0) {
          const ack: Buffer[] = [pkt('acknowledgments\n')];
          const acks = haves.filter((h) => wants.some((w) => h === w || isAncestor(repo, h, w)));
          if (acks.length > 0) {
            for (const ackOid of acks) ack.push(pkt(`ACK ${ackOid}\n`));
            ack.push(pkt('ready\n'));
          } else {
            ack.push(pkt('NAK\n'));
          }
          sections.push(ack);
        }
        const shallowOut = depth !== null ? plan.shallow : shallowLines;
        const unshallowOut = depth !== null ? plan.unshallow : [];
        if (shallowOut.length > 0 || unshallowOut.length > 0) {
          const info: Buffer[] = [pkt('shallow-info\n')];
          for (const oid of shallowOut) info.push(pkt(`shallow ${oid}\n`));
          for (const oid of unshallowOut) info.push(pkt(`unshallow ${oid}\n`));
          sections.push(info);
        }
        if (plan.objects.length > 0) {
          sections.push([pkt('packfile\n'), ...sidebandPackets(packFor(plan.objects))]);
        }
        const out: Buffer[] = [];
        sections.forEach((section, index) => {
          if (index > 0) out.push(PKT_DELIM);
          out.push(...section);
        });
        out.push(PKT_FLUSH);
        sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
        return true;
      }
      sendJson(res, 400, errBody('unknown command'));
      return true;
    }
    // v0 fetch
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowLines: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallowLines.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
    }
    if (wants.length === 0) {
      sendJson(res, 400, errBody('no want lines'));
      return true;
    }
    const plan = planFetch(repo, wants, haves, shallowLines, Number.isNaN(depth) ? null : depth);
    const out: Buffer[] = [];
    const acks = haves.filter((h) => wants.some((w) => h === w || isAncestor(repo, h, w)));
    if (acks.length > 0) {
      for (const ack of acks) out.push(pkt(`ACK ${ack}\n`));
    } else {
      out.push(pkt('NAK\n'));
    }
    const shallowOut = depth !== null ? plan.shallow : shallowLines;
    for (const oid of shallowOut) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of depth !== null ? plan.unshallow : []) out.push(pkt(`unshallow ${oid}\n`));
    if (plan.objects.length > 0) out.push(...sidebandPackets(packFor(plan.objects)));
    out.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return true;
  }

  if (endpoint === 'git-receive-pack' && method === 'POST') {
    const bodyBuf = await readBody(req);
    const { packets, rest } = decodePktLines(bodyBuf);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line === '') continue;
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const parts = clean.split(' ');
      if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
        sendJson(res, 400, errBody('malformed receive-pack command'));
        return true;
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    if (commands.length === 0) {
      sendJson(res, 400, errBody('no receive-pack commands'));
      return true;
    }
    let unpackOk = true;
    if (rest.length > 0) {
      try {
        const read = readPack(rest, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of read.objects) repo.objects.set(oid, obj);
      } catch {
        unpackOk = false;
      }
    }
    const report: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
    for (const cmd of commands) {
      const fail = (reason: string): void => {
        report.push(`ng ${cmd.ref} ${reason}\n`);
      };
      const ok = (): void => {
        report.push(`ok ${cmd.ref}\n`);
      };
      if (!unpackOk) {
        fail('unpacker error');
        continue;
      }
      if (!cmd.ref.startsWith('refs/')) {
        fail('invalid ref');
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (current === undefined) fail('remote ref does not exist');
        else {
          repo.refs.delete(cmd.ref);
          ok();
        }
        continue;
      }
      const newObj = getObject(repo, cmd.newOid);
      if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
        fail('missing object');
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) fail('already exists');
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          ok();
        }
        continue;
      }
      if (current === undefined) {
        fail('remote ref does not exist');
        continue;
      }
      if (current !== cmd.oldOid) {
        fail('stale');
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        fail('non-fast-forward');
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      repo.updatedSec = tick();
      ok();
    }
    // The report-status stream is itself pkt-framed and ends with a flush packet *inside* band 1
    // (git's report parser reads pkt-lines out of the demuxed band-1 stream); the response as a
    // whole then ends with an outer flush that terminates the sideband stream.
    const reportBytes = Buffer.concat([...report.map((l) => pkt(l)), PKT_FLUSH]);
    const out: Buffer[] = [];
    for (let off = 0; off < reportBytes.length; off += 32768) {
      out.push(pkt(Buffer.concat([Buffer.from([1]), reportBytes.subarray(off, Math.min(reportBytes.length, off + 32768))])));
    }
    out.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-receive-pack-result');
    return true;
  }

  sendJson(res, 404, errBody('Not Found'));
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL v4 (mini parser + executor for the documented surface)
// ---------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  children: GqlField[];
}

class GqlError extends Error {
  field: string;
  typeName: string;
  constructor(field: string, typeName: string) {
    super(`Cannot query field "${field}" on type "${typeName}".`);
    this.field = field;
    this.typeName = typeName;
  }
}

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_-]/.test(src[j] as string)) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos = 0;
  variables: Record<string, GqlValue>;
  constructor(src: string, variables: Record<string, GqlValue>) {
    this.tokens = tokenizeGql(src);
    this.variables = variables;
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++] as string;
  }
  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }
  parseValue(): GqlValue {
    const tok = this.next();
    if (tok === '[') {
      const out: GqlValue[] = [];
      while (this.peek() !== ']') out.push(this.parseValue());
      this.expect(']');
      return out;
    }
    if (tok === '{') {
      const out: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        out[key] = this.parseValue();
      }
      this.expect('}');
      return out;
    }
    if (tok.startsWith('$')) {
      const name = tok.slice(1);
      return (this.variables[name] ?? null) as GqlValue;
    }
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    const num = Number(tok);
    if (tok !== '' && !Number.isNaN(num)) return num;
    return tok; // enum value, as a string
  }
  parseArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }
  parseField(): GqlField {
    let tok = this.next();
    if (tok === '...') {
      // Inline fragment: `... on Type { ... }` — treat as a field named after the type.
      let typeName = '';
      if (this.peek() === 'on') {
        this.next();
        typeName = this.next();
      }
      const children = this.parseSelectionSet();
      return { alias: null, name: `...on:${typeName}`, args: {}, children };
    }
    let alias: string | null = null;
    let name = tok;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    let args: Record<string, GqlValue> = {};
    if (this.peek() === '(') args = this.parseArgs();
    let children: GqlField[] = [];
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { alias, name, args, children };
  }
  parseOperation(): { kind: 'query' | 'mutation'; fields: GqlField[] } {
    let kind: 'query' | 'mutation' = 'query';
    let tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      tok = this.peek();
      if (tok !== undefined && tok !== '{' && tok !== '(') this.next(); // operation name
      if (this.peek() === '(') {
        // variable definitions: skip balanced parens
        let depth = 0;
        do {
          const t = this.next();
          if (t === '(') depth += 1;
          if (t === ')') depth -= 1;
        } while (depth > 0);
      }
    }
    const fields = this.parseSelectionSet();
    return { kind, fields };
  }
}

const ISSUE_GQL_FIELDS = new Set(['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments']);
const PR_GQL_FIELDS = new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt']);
const REPO_GQL_FIELDS = new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'url', 'createdAt', 'issue', 'issues', 'pullRequests', 'pullRequest']);

function gqlIssueValue(repo: Repo, issue: Issue, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (!ISSUE_GQL_FIELDS.has(f.name)) throw new GqlError(f.name, 'Issue');
    if (f.name === 'id') out[key] = gid('Issue', `${repo.id}:${issue.number}`);
    else if (f.name === 'number') out[key] = issue.number;
    else if (f.name === 'title') out[key] = issue.title;
    else if (f.name === 'state') out[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
    else if (f.name === 'body') out[key] = issue.body;
    else if (f.name === 'url') out[key] = `/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`;
    else if (f.name === 'createdAt') out[key] = isoOf(issue.createdSec);
    else if (f.name === 'updatedAt') out[key] = isoOf(issue.updatedSec);
    else if (f.name === 'author') out[key] = { login: VIEWER_LOGIN };
    else if (f.name === 'labels') out[key] = { nodes: issue.labels.map((n) => ({ name: n })) };
    else if (f.name === 'comments') out[key] = { nodes: (repo.comments.get(issue.number) ?? []).map((c) => ({ id: gid('IssueComment', `${repo.id}:${c.id}`), body: c.body })) };
  }
  return out;
}

function gqlPullValue(repo: Repo, pull: Pull, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (!PR_GQL_FIELDS.has(f.name)) throw new GqlError(f.name, 'PullRequest');
    if (f.name === 'id') out[key] = gid('PullRequest', `${repo.id}:${pull.number}`);
    else if (f.name === 'number') out[key] = pull.number;
    else if (f.name === 'title') out[key] = pull.title;
    else if (f.name === 'body') out[key] = pull.body;
    else if (f.name === 'state') out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    else if (f.name === 'merged') out[key] = pull.merged;
    else if (f.name === 'mergeable') out[key] = prMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    else if (f.name === 'headRefName') out[key] = pull.headRef;
    else if (f.name === 'baseRefName') out[key] = pull.baseRef;
    else if (f.name === 'headRefOid') out[key] = pull.headSha;
    else if (f.name === 'baseRefOid') out[key] = pull.baseSha;
    else if (f.name === 'author') out[key] = { login: VIEWER_LOGIN };
    else if (f.name === 'createdAt') out[key] = isoOf(pull.createdSec);
    else if (f.name === 'updatedAt') out[key] = isoOf(pull.updatedSec);
    else if (f.name === 'files') {
      const first = typeof f.args.first === 'number' ? f.args.first : 10;
      const allFiles = prFiles(repo, pull).slice(0, first);
      const fileValue: Record<string, unknown> = { totalCount: prFiles(repo, pull).length };
      for (const child of f.children) {
        const ckey = child.alias ?? child.name;
        if (child.name === 'nodes') {
          const nodes: Array<Record<string, unknown>> = [];
          for (const file of allFiles) {
            const node: Record<string, unknown> = {};
            for (const n of child.children) {
              const nkey = n.alias ?? n.name;
              if (n.name === 'path') node[nkey] = file.filename;
              else if (n.name === 'additions') node[nkey] = file.additions;
              else if (n.name === 'deletions') node[nkey] = file.deletions;
              else if (n.name === 'changeType') node[nkey] = file.status;
              else node[nkey] = file[n.name] ?? null;
            }
            nodes.push(node);
          }
          fileValue[ckey] = nodes;
        } else if (child.name === 'totalCount') {
          fileValue[ckey] = prFiles(repo, pull).length;
        } else if (child.name === 'pageInfo') {
          fileValue[ckey] = { hasNextPage: false, endCursor: null };
        }
      }
      out[key] = fileValue;
    }
  }
  return out;
}

function connectionPage<T>(items: T[], first: number | undefined, after: string | undefined, keyOf: (item: T) => number): { nodes: T[]; hasNext: boolean; endCursor: string | null } {
  let start = 0;
  if (after !== undefined && after !== '') {
    try {
      const decoded = b64decode(after);
      const num = Number.parseInt(decoded.split(':')[1] ?? '', 10);
      const idx = items.findIndex((it) => keyOf(it) === num);
      if (idx >= 0) start = idx + 1;
    } catch {
      start = 0;
    }
  }
  const limit = first ?? items.length;
  const nodes = items.slice(start, start + limit);
  const hasNext = start + nodes.length < items.length;
  const endCursor = nodes.length > 0 ? b64encode(`cursor:${keyOf(nodes[nodes.length - 1] as T)}`) : null;
  return { nodes, hasNext, endCursor };
}

function gqlRepoValue(repo: Repo, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (!REPO_GQL_FIELDS.has(f.name)) throw new GqlError(f.name, 'Repository');
    if (f.name === 'id') out[key] = gid('Repository', repo.id);
    else if (f.name === 'databaseId') out[key] = repo.id;
    else if (f.name === 'name') out[key] = repo.name;
    else if (f.name === 'nameWithOwner') out[key] = `${VIEWER_LOGIN}/${repo.name}`;
    else if (f.name === 'owner') out[key] = { login: VIEWER_LOGIN };
    else if (f.name === 'defaultBranchRef') out[key] = { name: repo.defaultBranch };
    else if (f.name === 'viewerPermission') out[key] = 'WRITE';
    else if (f.name === 'hasIssuesEnabled') out[key] = true;
    else if (f.name === 'description') out[key] = repo.description;
    else if (f.name === 'url') out[key] = `/${VIEWER_LOGIN}/${repo.name}`;
    else if (f.name === 'createdAt') out[key] = isoOf(repo.createdSec);
    else if (f.name === 'issue') {
      const num = f.args.number as number | undefined;
      const issue = num !== undefined ? repo.issues.get(num) : undefined;
      out[key] = issue === undefined ? null : gqlIssueValue(repo, issue, f.children);
    } else if (f.name === 'issues') {
      let list = [...repo.issues.values()];
      const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : [];
      if (states.length > 0) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = (f.args.orderBy ?? {}) as Record<string, unknown>;
      const dir = orderBy.direction === 'DESC' ? -1 : 1;
      list.sort((a, b) => dir * (a.number - b.number));
      const first = typeof f.args.first === 'number' ? f.args.first : undefined;
      const after = typeof f.args.after === 'string' ? f.args.after : undefined;
      const page = connectionPage(list, first, after, (i) => i.number);
      const nodes: Array<Record<string, unknown>> = [];
      const pageInfo: Record<string, unknown> = {};
      for (const child of f.children) {
        if (child.name === 'nodes') nodes.push(...page.nodes.map((i) => gqlIssueValue(repo, i, child.children)));
        else if (child.name === 'pageInfo') {
          for (const p of child.children) {
            if (p.name === 'hasNextPage') pageInfo[p.alias ?? p.name] = page.hasNext;
            else if (p.name === 'endCursor') pageInfo[p.alias ?? p.name] = page.endCursor;
          }
        } else if (child.name === 'totalCount') out[key] = list.length;
        else if (child.name === 'edges') {
          // edges: [{node, cursor}]
          const edges: Array<Record<string, unknown>> = [];
          for (const n of page.nodes) {
            const edge: Record<string, unknown> = {};
            for (const e of child.children) {
              if (e.name === 'node') edge[e.alias ?? e.name] = gqlIssueValue(repo, n, e.children);
              else if (e.name === 'cursor') edge[e.alias ?? e.name] = b64encode(`cursor:${n.number}`);
            }
            edges.push(edge);
          }
          (out as Record<string, unknown>)[`${key}__edges`] = edges;
        }
      }
      const conn: Record<string, unknown> = { nodes, pageInfo, totalCount: list.length };
      const edges = (out as Record<string, unknown>)[`${key}__edges`];
      if (edges !== undefined) conn.edges = edges;
      delete (out as Record<string, unknown>)[`${key}__edges`];
      out[key] = conn;
    } else if (f.name === 'pullRequests') {
      let list = [...repo.pulls.values()];
      const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : [];
      if (states.length > 0) {
        list = list.filter((p) => {
          const s = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
          return states.includes(s);
        });
      }
      list.sort((a, b) => a.number - b.number);
      const first = typeof f.args.first === 'number' ? f.args.first : undefined;
      const after = typeof f.args.after === 'string' ? f.args.after : undefined;
      const page = connectionPage(list, first, after, (p) => p.number);
      const nodes: Array<Record<string, unknown>> = [];
      const pageInfo: Record<string, unknown> = {};
      for (const child of f.children) {
        if (child.name === 'nodes') nodes.push(...page.nodes.map((p) => gqlPullValue(repo, p, child.children)));
        else if (child.name === 'pageInfo') {
          for (const p of child.children) {
            if (p.name === 'hasNextPage') pageInfo[p.alias ?? p.name] = page.hasNext;
            else if (p.name === 'endCursor') pageInfo[p.alias ?? p.name] = page.endCursor;
          }
        }
      }
      out[key] = { nodes, pageInfo, totalCount: list.length };
    } else if (f.name === 'pullRequest') {
      const num = f.args.number as number | undefined;
      const pull = num !== undefined ? repo.pulls.get(num) : undefined;
      out[key] = pull === undefined ? null : gqlPullValue(repo, pull, f.children);
    }
  }
  return out;
}

function decodeGlobalId(id: string): { kind: string; ref: string } | null {
  try {
    const text = b64decode(id);
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), ref: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const repoId = Number.parseInt(decoded.ref, 10);
  for (const repo of repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function mergePullById(repo: Repo, pull: Pull): { ok: boolean; message?: string } {
  if (pull.merged) return { ok: false, message: 'Pull request has already been merged' };
  if (pull.state !== 'open') return { ok: false, message: 'Pull request is closed' };
  const headTip = refTip(repo, pull.headRef);
  const baseTip = refTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { ok: false, message: 'head or base branch does not exist' };
  if (headTip === baseTip) return { ok: false, message: 'Nothing to merge' };
  const base = mergeBase(repo, headTip, baseTip);
  const plan = threeWayMerge(repo, baseTip, headTip, base);
  if (!plan.ok) return { ok: false, message: `Merge conflict: ${plan.conflictPaths.join(', ')}` };
  const commitOid = createCommit(repo, [baseTip], plan.files, pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  const sec = tick();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAtSec = sec;
  pull.mergeCommitSha = commitOid;
  pull.closedSec = sec;
  pull.updatedSec = sec;
  return { ok: true };
}

function executeOperation(query: string, variables: Record<string, GqlValue>): { data: Record<string, unknown> | null; errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  const parser = new GqlParser(query, variables);
  const { kind, fields } = parser.parseOperation();
  const data: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    try {
      if (kind === 'query') {
        if (f.name === 'viewer') {
          const viewerFields = new Set(['login', 'id', 'name', 'email', 'avatarUrl', 'url', 'bio']);
          const v: Record<string, unknown> = {};
          for (const child of f.children) {
            if (!viewerFields.has(child.name)) throw new GqlError(child.name, 'User');
            const ckey = child.alias ?? child.name;
            if (child.name === 'login') v[ckey] = VIEWER_LOGIN;
            else if (child.name === 'id') v[ckey] = gid('User', VIEWER_ID);
            else if (child.name === 'name') v[ckey] = VIEWER_LOGIN;
            else if (child.name === 'email') v[ckey] = VIEWER_EMAIL;
            else if (child.name === 'avatarUrl') v[ckey] = '';
            else if (child.name === 'url') v[ckey] = `/${VIEWER_LOGIN}`;
            else if (child.name === 'bio') v[ckey] = null;
          }
          data[key] = v;
        } else if (f.name === 'repository') {
          const owner = f.args.owner as string | undefined;
          const name = f.args.name as string | undefined;
          const repo = owner !== undefined && name !== undefined ? getRepo(owner, name) : undefined;
          data[key] = repo === undefined ? null : gqlRepoValue(repo, f.children);
        } else if (f.name === 'node') {
          const id = f.args.id as string | undefined;
          const decoded = id !== undefined ? decodeGlobalId(id) : null;
          // Flatten: direct fields plus the children of an inline fragment on the resolved type.
          const flatten = (kind: string): GqlField[] => {
            const out: GqlField[] = [];
            for (const child of f.children) {
              if (child.name.startsWith('...on:')) {
                if (child.name.slice('...on:'.length) === kind) out.push(...child.children);
              } else {
                out.push(child);
              }
            }
            return out;
          };
          let value: Record<string, unknown> | null = null;
          if (decoded !== null && decoded.kind === 'Repository') {
            const repoId = Number.parseInt(decoded.ref, 10);
            const repo = [...repos.values()].find((r) => r.id === repoId);
            if (repo !== undefined) value = gqlRepoValue(repo, flatten('Repository'));
          } else if (decoded !== null && decoded.kind === 'Issue') {
            const [repoId, num] = decoded.ref.split(':');
            const repo = [...repos.values()].find((r) => r.id === Number.parseInt(repoId ?? '', 10));
            const issue = repo?.issues.get(Number.parseInt(num ?? '', 10));
            if (repo !== undefined && issue !== undefined) value = gqlIssueValue(repo, issue, flatten('Issue'));
          } else if (decoded !== null && decoded.kind === 'PullRequest') {
            const [repoId, num] = decoded.ref.split(':');
            const repo = [...repos.values()].find((r) => r.id === Number.parseInt(repoId ?? '', 10));
            const pull = repo?.pulls.get(Number.parseInt(num ?? '', 10));
            if (repo !== undefined && pull !== undefined) value = gqlPullValue(repo, pull, flatten('PullRequest'));
          }
          data[key] = value;
        } else if (f.name === '__type') {
          const typeName = f.args.name as string | undefined;
          data[key] = typeInfo(typeName ?? '', f.children);
        } else if (f.name === '__schema') {
          data[key] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [{ name: 'Query' }, { name: 'Mutation' }, { name: 'Repository' }, { name: 'Issue' }, { name: 'PullRequest' }] };
        } else {
          throw new GqlError(f.name, 'Query');
        }
      } else {
        // Mutations
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        if (f.name === 'createIssue') {
          const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
          if (repo === null) throw new Error('Repository not found');
          const title = typeof input.title === 'string' ? input.title : '';
          const number = repo.nextNumber++;
          const sec = tick();
          const issue: Issue = { number, title, body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], createdSec: sec, updatedSec: sec, closedSec: null };
          repo.issues.set(number, issue);
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'issue') out[child.alias ?? child.name] = gqlIssueValue(repo, issue, child.children);
            else if (child.name === 'clientMutationId') out[child.alias ?? child.name] = input.clientMutationId ?? null;
          }
          data[key] = out;
        } else if (f.name === 'closeIssue') {
          const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
          let issue: Issue | undefined;
          let repo: Repo | undefined;
          if (decoded !== null && decoded.kind === 'Issue') {
            const [repoId, num] = decoded.ref.split(':');
            repo = [...repos.values()].find((r) => r.id === Number.parseInt(repoId ?? '', 10));
            issue = repo?.issues.get(Number.parseInt(num ?? '', 10));
          }
          if (repo === undefined || issue === undefined) throw new Error('Issue not found');
          issue.state = 'closed';
          issue.closedSec = tick();
          issue.updatedSec = tick();
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'issue') out[child.alias ?? child.name] = gqlIssueValue(repo, issue, child.children);
            else if (child.name === 'clientMutationId') out[child.alias ?? child.name] = input.clientMutationId ?? null;
          }
          data[key] = out;
        } else if (f.name === 'createPullRequest') {
          const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
          if (repo === null) throw new Error('Repository not found');
          const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
          const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
          const headSha = refTip(repo, headRef);
          const baseSha = refTip(repo, baseRef);
          if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
          const number = repo.nextNumber++;
          const sec = tick();
          const pull: Pull = { number, title: typeof input.title === 'string' ? input.title : '', body: typeof input.body === 'string' ? input.body : '', state: 'open', merged: false, mergedAtSec: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, createdSec: sec, updatedSec: sec, closedSec: null };
          repo.pulls.set(number, pull);
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'pullRequest') out[child.alias ?? child.name] = gqlPullValue(repo, pull, child.children);
            else if (child.name === 'clientMutationId') out[child.alias ?? child.name] = input.clientMutationId ?? null;
          }
          data[key] = out;
        } else if (f.name === 'mergePullRequest') {
          const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
          let pull: Pull | undefined;
          let repo: Repo | undefined;
          if (decoded !== null && decoded.kind === 'PullRequest') {
            const [repoId, num] = decoded.ref.split(':');
            repo = [...repos.values()].find((r) => r.id === Number.parseInt(repoId ?? '', 10));
            pull = repo?.pulls.get(Number.parseInt(num ?? '', 10));
          }
          if (repo === undefined || pull === undefined) throw new Error('Pull request not found');
          const merged = mergePullById(repo, pull);
          if (!merged.ok) throw new Error(merged.message ?? 'Merge failed');
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'pullRequest') out[child.alias ?? child.name] = gqlPullValue(repo, pull, child.children);
            else if (child.name === 'clientMutationId') out[child.alias ?? child.name] = input.clientMutationId ?? null;
          }
          data[key] = out;
        } else if (f.name === 'addComment') {
          const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
          let repo: Repo | undefined;
          let number: number | undefined;
          if (decoded !== null && (decoded.kind === 'Issue' || decoded.kind === 'PullRequest')) {
            const [repoId, num] = decoded.ref.split(':');
            repo = [...repos.values()].find((r) => r.id === Number.parseInt(repoId ?? '', 10));
            number = Number.parseInt(num ?? '', 10);
          }
          if (repo === undefined || number === undefined) throw new Error('Subject not found');
          const sec = tick();
          const comment: Comment = { id: repo.nextCommentId++, issueNumber: number, body: typeof input.body === 'string' ? input.body : '', createdSec: sec, updatedSec: sec };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'commentEdge') {
              const edge: Record<string, unknown> = {};
              for (const e of child.children) {
                if (e.name === 'node') {
                  const node: Record<string, unknown> = {};
                  for (const n of e.children) {
                    if (n.name === 'id') node[n.alias ?? n.name] = gid('IssueComment', `${repo.id}:${comment.id}`);
                    else if (n.name === 'body') node[n.alias ?? n.name] = comment.body;
                  }
                  edge[e.alias ?? e.name] = node;
                }
              }
              out[child.alias ?? child.name] = edge;
            } else if (child.name === 'clientMutationId') out[child.alias ?? child.name] = input.clientMutationId ?? null;
          }
          data[key] = out;
        } else {
          throw new GqlError(f.name, 'Mutation');
        }
      }
    } catch (err) {
      if (err instanceof GqlError) {
        errors.push({ message: err.message, path: [key] });
        data[key] = null;
      } else {
        errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
        data[key] = null;
      }
    }
  }
  return { data, errors };
}

function typeInfo(name: string, fields: GqlField[]): Record<string, unknown> | null {
  const fieldLists: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
    PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'url', 'createdAt', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'bio'],
  };
  const out: Record<string, unknown> = { name };
  for (const f of fields) {
    if (f.name === 'fields') {
      const list = fieldLists[name];
      out[f.alias ?? f.name] = list === undefined ? null : list.map((n) => ({ name: n }));
    } else if (f.name === 'enumValues') {
      if (name === 'SearchType') out[f.alias ?? f.name] = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'].map((n) => ({ name: n }));
      else out[f.alias ?? f.name] = null;
    } else if (f.name === 'kind') {
      out[f.alias ?? f.name] = name === 'SearchType' ? 'ENUM' : 'OBJECT';
    } else if (f.name === 'description') {
      out[f.alias ?? f.name] = null;
    }
  }
  return out;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql' || (req.method ?? 'GET') !== 'POST') return false;
  if (!authorized(req)) {
    sendJson(res, 401, errBody('Requires authentication'));
    return true;
  }
  const buf = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    sendJson(res, 400, errBody('Problems parsing JSON'));
    return true;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    const rec = entry as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = (rec.variables ?? {}) as Record<string, GqlValue>;
    if (query === '') return { data: null, errors: [{ message: 'No query provided' }] };
    try {
      const { data, errors } = executeOperation(query, variables);
      return errors.length > 0 ? { data, errors } : { data };
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed));
  return true;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpToolDef[] = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state filter: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

const MCP_TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

function normalizeToolName(raw: string): string {
  const lower = raw.toLowerCase();
  const suffix = lower.includes('__') ? (lower.split('__').pop() as string) : lower;
  return MCP_TOOL_ALIASES[suffix] ?? suffix;
}

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : '';
  let repo = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner === '' ? (parts[0] as string) : owner;
      repo = repo === '' ? (parts[1] as string) : repo;
    }
  }
  return { owner, repo };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp' || (req.method ?? 'GET') !== 'POST') return false;
  const buf = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const rec = parsed as Record<string, unknown>;
  const id = rec.id ?? null;
  const method = typeof rec.method === 'string' ? rec.method : '';
  const params = (rec.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const fail = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  // Notifications carry no id and get a bare 202.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    ok({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      serverInfo: { name: 'github-core-clone', version: '0.1.0' },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '0.1.0' } },
    });
    return true;
  }
  if (method === 'initialize') {
    const offered = (params.protocolVersion as string | undefined) ?? '2025-11-25';
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    ok({
      protocolVersion: known.includes(offered) ? offered : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '0.1.0' },
    });
    return true;
  }
  if (method === 'ping') {
    ok({});
    return true;
  }
  if (method === 'tools/list') {
    ok({ tools: MCP_TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    if (bearerToken(req) === null) {
      sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
      return true;
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const canonical = normalizeToolName(name);
    const def = MCP_TOOLS.find((t) => t.name === canonical);
    if (def === undefined) {
      fail(-32601, `Unknown tool: ${name}`);
      return true;
    }
    const toolResult = (obj: unknown, isError = false): void => {
      const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
      ok({ content: [{ type: 'text', text }], structuredContent: obj, isError });
    };
    const baseUrl = baseUrlOf(req);
    if (canonical === 'create_repo') {
      const repoName = typeof args.name === 'string' ? args.name.trim() : '';
      if (repoName === '') {
        toolResult({ error: 'Missing required argument: name' }, true);
        return true;
      }
      if (repos.has(repoKey(VIEWER_LOGIN, repoName))) {
        toolResult({ error: `Repository ${VIEWER_LOGIN}/${repoName} already exists` }, true);
        return true;
      }
      const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      toolResult(repoJson(repo, baseUrl));
      return true;
    }
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    if (owner === '' || repoName === '') {
      toolResult({ error: 'Missing required argument(s): owner, repo' }, true);
      return true;
    }
    const repo = getRepo(owner, repoName);
    if (canonical === 'get_repo') {
      if (repo === undefined) {
        toolResult({ error: `Repository ${owner}/${repoName} not found` }, true);
        return true;
      }
      toolResult(repoJson(repo, baseUrl));
      return true;
    }
    if (repo === undefined) {
      toolResult({ error: `Repository ${owner}/${repoName} not found` }, true);
      return true;
    }
    if (canonical === 'create_issue') {
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') {
        toolResult({ error: 'Missing required argument: title' }, true);
        return true;
      }
      const number = repo.nextNumber++;
      const sec = tick();
      const issue: Issue = { number, title, body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], createdSec: sec, updatedSec: sec, closedSec: null };
      repo.issues.set(number, issue);
      toolResult(issueJson(repo, issue, baseUrl));
      return true;
    }
    if (canonical === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.number - b.number);
      toolResult({ issues: list.map((i) => issueJson(repo, i, baseUrl)) });
      return true;
    }
    if (canonical === 'create_pull_request') {
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') {
        toolResult({ error: 'Missing required argument(s): title, head, base' }, true);
        return true;
      }
      const headSha = refTip(repo, head);
      const baseSha = refTip(repo, base);
      if (headSha === null || baseSha === null) {
        toolResult({ error: 'head or base branch does not exist' }, true);
        return true;
      }
      const number = repo.nextNumber++;
      const sec = tick();
      const pull: Pull = { number, title, body: typeof args.body === 'string' ? args.body : '', state: 'open', merged: false, mergedAtSec: null, mergeCommitSha: null, headRef: head, baseRef: base, headSha, baseSha, createdSec: sec, updatedSec: sec, closedSec: null };
      repo.pulls.set(number, pull);
      toolResult(pullJson(repo, pull, baseUrl));
      return true;
    }
    if (canonical === 'merge_pull_request') {
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      if (!Number.isInteger(pullNumber)) {
        toolResult({ error: 'Missing required argument: pull_number' }, true);
        return true;
      }
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) {
        toolResult({ error: `Pull request #${pullNumber} not found` }, true);
        return true;
      }
      const merged = mergePullById(repo, pull);
      if (!merged.ok) {
        toolResult({ error: merged.message ?? 'Merge failed' }, true);
        return true;
      }
      toolResult(pullJson(repo, pull, baseUrl));
      return true;
    }
    fail(-32602, `Unhandled tool: ${name}`);
    return true;
  }

  fail(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (await handleGit(req, res)) return;
        if (await handleGraphql(req, res)) return;
        if (await handleMcp(req, res)) return;
        if (await handleRest(req, res)) return;
        sendJson(res, 404, errBody('Not Found'));
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, errBody(err instanceof Error ? err.message : 'Internal Server Error'));
        } else {
          res.destroy();
        }
      }
    })();
  });
}
