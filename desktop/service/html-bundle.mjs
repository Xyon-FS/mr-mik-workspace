import path from 'node:path';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { within } from './util.mjs';
export async function bundleHtml(text, cwd) {
  const root = await realpath(cwd), cache = new Map(); let bytes = Buffer.byteLength(text);
  const load = async (reference, base = root) => {
    if (!reference || /^[a-z][\w+.-]*:|^[/\\]|[?#\x00-\x1f]/i.test(reference)) throw new Error('Bundle assets must be relative local project paths.');
    const candidate = path.resolve(base, reference), actual = await realpath(candidate);
    if (!within(root, actual) || !(await lstat(actual)).isFile()) throw new Error('Bundle asset is outside the selected project.');
    if (path.relative(root, actual).split(path.sep).some(part => part.startsWith('.') || /^(?:node_modules|credentials|auth|tokens?)(?:\.|$)/i.test(part))) throw new Error('Choose public project assets outside private configuration folders.');
    if (cache.has(actual)) return cache.get(actual);
    if (cache.size >= 20) throw new Error('An HTML bundle can include up to 20 local assets.');
    const info = await lstat(actual); if (info.size > 150000 || bytes + info.size > 200000) throw new Error('The local HTML bundle exceeds 200 KB.');
    const data = await readFile(actual); bytes += data.length; cache.set(actual, data); return data;
  };
  const dataUrl = async (reference, base = root) => {
    const type = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' })[path.extname(reference).toLowerCase()];
    if (!type) throw new Error('Bundle images/fonts must be PNG, JPEG, GIF, WebP or WOFF.');
    return `data:${type};base64,${(await load(reference, base)).toString('base64')}`;
  };
  for (const match of [...text.matchAll(/<link\b[^>]*>/gi)]) {
    if (!/\brel=['"]stylesheet['"]/i.test(match[0])) continue;
    const href = /href=['"]([^'"]+)['"]/i.exec(match[0])?.[1]; if (!href) continue;
    if (!/\.css$/i.test(href)) throw new Error('Choose a local CSS stylesheet.');
    let css = (await load(href)).toString('utf8'); if (/@import/i.test(css)) throw new Error('Combine imported CSS into one stylesheet before bundling.');
    for (const asset of [...css.matchAll(/url\(\s*['"]?([^'"()]+)['"]?\s*\)/gi)]) if (!asset[1].startsWith('data:') && !asset[1].startsWith('#')) css = css.replace(asset[0], `url("${await dataUrl(asset[1], path.dirname(path.resolve(root, href)))}")`);
    text = text.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
  }
  for (const match of [...text.matchAll(/<script\b([^>]*?)\bsrc=['"]([^'"]+)['"]([^>]*)>\s*<\/script>/gi)]) {
    if (!/\.(?:js|mjs)$/i.test(match[2]) || /type=['"]module['"]/i.test(match[0])) throw new Error('Local bundles support classic JavaScript; module imports need a project dev server.');
    const js = (await load(match[2])).toString('utf8'); text = text.replace(match[0], () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
  }
  for (const match of [...text.matchAll(/<img\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*>/gi)]) if (!match[1].startsWith('data:')) text = text.replace(match[0], match[0].replace(match[1], await dataUrl(match[1])));
  if (Buffer.byteLength(text) > 200000) throw new Error('The encoded HTML bundle exceeds 200 KB.');
  return text;
}
