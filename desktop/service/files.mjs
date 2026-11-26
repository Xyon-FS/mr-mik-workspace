import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, realpath, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { realFile, secret, within } from './util.mjs';
import { serveReport } from './report-chrome.mjs';
import { InteractivePreviews } from './interactive-preview.mjs';
import { isDevelopmentFile } from './development-files.mjs';

const mime = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const textExtensions = new Set(['.txt', '.md', '.json', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.py', '.rs', '.toml', '.yaml', '.yml', '.csv', '.tsv', '.log', '.xml', '.ini', '.ps1', '.cmd', '.sh', '.gitignore']);
const secretPart = value => value.startsWith('.') || /^(node_modules|target|oauth_.*\.json|.*_secret.*\.json|tokens?\.json|auth\.json)$/i.test(value);
const sameRevision = (info, revision) => ['dev', 'ino', 'mtimeMs', 'ctimeMs', 'size'].every(key => info[key] === revision[key]);

export async function serveFile(request, response, file, info, headers = {}) {
  const contentType = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const common = { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...headers };
  let start = 0, end = info.size - 1, status = 200;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match || (!match[1] && !match[2]) || info.size === 0) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    if (!match[1]) { start = Math.max(0, info.size - Number(match[2])); }
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    status = 206; common['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  response.writeHead(status, { ...common, 'Content-Length': Math.max(0, end - start + 1) });
  if (request.method === 'HEAD' || info.size === 0) { response.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

export class Files {
  constructor(repo) { this.repo = repo; this.grants = new Map(); this.scopedGrants = new Map(); this.repoGrant = this.grant(repo); this.writes = Promise.resolve(); this.interactive = new InteractivePreviews(); }
  async cardPreview(plan) {
    if (plan.kind !== 'card' || !/\.html?$/i.test(plan.file)) return {};
    const file = await realpath(plan.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!file) return {};
    const root = await realpath(this.repo), folder = await realpath(plan.folder);
    if (!within(root, folder) || !within(folder, file) || !(await stat(file)).isFile()) throw new Error('Invalid card preview destination.');
    const shared = await realpath(path.join(root, 'workspace', '_shared')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const allowed = [folder, ...(shared && within(root, shared) ? [shared] : [])];
    const key = JSON.stringify(allowed);
    let token = [...this.scopedGrants].find(([, grant]) => grant.key === key)?.[0];
    if (!token) {
      token = secret();
      if (this.scopedGrants.size >= 256) this.scopedGrants.delete(this.scopedGrants.keys().next().value);
      this.scopedGrants.set(token, { root, allowed, key });
    }
    return { previewUrl: `${this.origin}/view/${token}/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/')}` };
  }
  grant(root) {
    for (const [token, value] of this.grants) if (value === root) return token;
    const token = secret(); this.grants.set(token, root); return token;
  }
  url(file) {
    const absolute = path.resolve(file);
    const relative = path.relative(this.repo, absolute);
    const root = within(this.repo, absolute) && !relative.split(/[\\/]/).some(secretPart) ? this.repo : path.dirname(absolute);
    return `${this.origin}/view/${this.grant(root)}/${path.relative(root, absolute).split(path.sep).map(encodeURIComponent).join('/')}`;
  }
  singleFileUrl(file, revision) {
    const absolute = path.resolve(file), key = `file:${absolute}${revision ? `:${revision.dev}:${revision.ino}:${revision.mtimeMs}:${revision.ctimeMs}:${revision.size}` : ''}`;
    if (secretPart(path.basename(absolute))) throw new Error('Private application files cannot be loaded in the document viewer.');
    let token = [...this.scopedGrants].find(([, grant]) => grant.key === key)?.[0];
    if (!token) {
      token = secret();
      if (this.scopedGrants.size >= 256) this.scopedGrants.delete(this.scopedGrants.keys().next().value);
      this.scopedGrants.set(token, { key, root: path.dirname(absolute), file: absolute, allowed: [], revision });
    }
    return `${this.origin}/view/${token}/${encodeURIComponent(path.basename(absolute))}`;
  }
  async list(folder = this.repo, mode = 'main', query = '') {
    const actual = await realpath(path.resolve(folder));
    const entries = await readdir(actual, { withFileTypes: true });
    const atRoot = actual.toLowerCase() === this.repo.toLowerCase();
    const filtered = entries.filter(entry => (!atRoot || mode === 'all' || ['inbox', 'projects', 'workspace', 'knowledge', 'processes', 'context'].includes(entry.name)) && (!query || entry.name.toLowerCase().includes(query.toLowerCase())));
    const result = await Promise.all(filtered.slice(0, 1500).map(async entry => {
      const full = path.join(actual, entry.name);
      const info = await stat(full).catch(() => null);
      return { name: entry.name, path: full, directory: info?.isDirectory() || entry.isDirectory(), size: info?.size || 0, modifiedAt: info?.mtime.toISOString() || null };
    }));
    if (atRoot && mode !== 'all') {
      for (const [name, relative] of [['Claude skills', '.claude/skills'], ['Codex skills', '.agents/skills']]) {
        const full = path.join(this.repo, relative), info = await stat(full).catch(() => null);
        if (info?.isDirectory()) result.push({ name, path: full, directory: true, size: 0, modifiedAt: info.mtime.toISOString() });
      }
    }
    result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { path: actual, parent: path.dirname(actual), entries: result, truncated: filtered.length > 1500, mode };
  }
  async preview(file, attachmentRevision) {
    const actual = await realpath(path.resolve(file));
    const info = await stat(actual);
    if (attachmentRevision && (actual !== file || !sameRevision(info, attachmentRevision))) throw new Error('This file changed. Reopen the attachment.');
    if (!info.isFile()) throw new Error('Choose a file to preview');
    const ext = path.extname(actual).toLowerCase();
    const base = { path: actual, name: path.basename(actual), size: info.size, identity: `${actual}:${info.mtimeMs}:${info.size}` };
    const url = () => attachmentRevision ? this.singleFileUrl(actual, info) : this.url(actual);
    if (['.html', '.htm', '.pdf'].includes(ext)) return { ...base, kind: 'document', url: url() };
    if (/^image\//.test(mime[ext] || '')) return { ...base, kind: 'image', url: url() };
    if (/^(video|audio)\//.test(mime[ext] || '')) return { ...base, kind: mime[ext].split('/')[0], url: url() };
    if (textExtensions.has(ext) || isDevelopmentFile(actual) || info.size === 0 || path.basename(actual).startsWith('.env')) {
      if (info.size > 2 * 1024 * 1024) return { ...base, kind: 'unsupported', reason: 'This text file is larger than the 2 MB preview limit.' };
      const bytes = await readFile(actual);
      return { ...base, kind: 'text', text: bytes.toString('utf8'), ...(ext === '.md' ? { revision: createHash('sha256').update(bytes).digest('hex'), url: url() } : {}) };
    }
    return { ...base, kind: 'unsupported', reason: 'Open this file in its desktop application.' };
  }
  async saveMarkdown({ path: requested, text, revision }) {
    if (typeof requested !== 'string' || path.extname(requested).toLowerCase() !== '.md' || typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(revision || '')) throw new Error('Choose a Markdown file of up to 2 MB with a current revision.');
    const operation = this.writes.catch(() => {}).then(async () => {
      const actual = await realpath(path.resolve(requested));
      if (path.extname(actual).toLowerCase() !== '.md') throw new Error('Only Markdown files can be edited.');
      const original = await readFile(actual);
      if (createHash('sha256').update(original).digest('hex') !== revision) throw Object.assign(new Error('This file changed on disk. Your draft is kept. Reopen the file to compare before saving.'), { status: 409 });
      const backupFolder = path.join(this.repo, '.mrmak', 'markdown-backups');
      await mkdir(backupFolder, { recursive: true });
      const id = `${Date.now()}-${randomUUID()}`;
      await writeFile(path.join(backupFolder, `${id}.md`), original, { flag: 'wx' });
      await writeFile(path.join(backupFolder, `${id}.json`), JSON.stringify({ path: actual, revision, savedAt: new Date().toISOString() }), { flag: 'wx' });
      const temp = path.join(path.dirname(actual), `.${path.basename(actual)}.${id}.tmp`);
      try {
        await writeFile(temp, text, { flag: 'wx' });
        if (createHash('sha256').update(await readFile(actual)).digest('hex') !== revision) throw Object.assign(new Error('This file changed while saving. Your draft is kept; reopen the file to compare.'), { status: 409 });
        await rename(temp, actual);
      } finally { await unlink(temp).catch(() => {}); }
      return this.preview(actual);
    });
    this.writes = operation;
    return operation;
  }
  async content(request, response, url) {
    if (await this.interactive.serve(request, response, url, this.uiOrigin)) return;
    const match = /^\/view\/([\w-]+)\/(.*)$/.exec(url.pathname);
    if (!match || (!this.grants.has(match[1]) && !this.scopedGrants.has(match[1]))) throw Object.assign(new Error('Preview not found'), { status: 404 });
    const relative = decodeURIComponent(match[2]);
    if (relative.split(/[\\/]/).some(secretPart)) throw Object.assign(new Error('Private application files cannot be loaded by reports'), { status: 403 });
    const scope = this.scopedGrants.get(match[1]);
    const { file, info } = await realFile(scope?.root || this.grants.get(match[1]), relative);
    if (scope && (scope.file ? scope.file !== file : !scope.allowed.some(root => within(root, file)))) throw Object.assign(new Error('Outside this card preview'), { status: 403 });
    if (!info.isFile()) throw Object.assign(new Error('File not found'), { status: 404 });
    if (scope?.revision && !sameRevision(info, scope.revision)) throw Object.assign(new Error('This file changed. Reopen the preview.'), { status: 409 });
    const serve = /\.html?$/i.test(file) ? serveReport : serveFile;
    await serve(request, response, file, info, { 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': this.uiOrigin, 'Cross-Origin-Resource-Policy': 'cross-origin' });
  }
}
