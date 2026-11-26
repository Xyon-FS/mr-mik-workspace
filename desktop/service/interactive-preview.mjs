import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

async function serveDiskPreview(request, response, url, headers, disk, bootstrap) {
  let handle;
  try {
    if (await realpath(disk.file) !== disk.file) throw new Error();
    handle = await open(disk.file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => info[key] !== disk.info[key]) || await realpath(disk.file) !== disk.file) throw new Error();
    const source = url.searchParams.get('source') === '1';
    if (source) headers['Content-Type'] = 'text/plain; charset=utf-8';
    const prefix = Buffer.alloc(source || request.method === 'HEAD' ? 0 : Math.min(info.size, 65536));
    const { bytesRead } = prefix.length ? await handle.read(prefix, 0, prefix.length, 0) : { bytesRead: 0 };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    if (!source) {
      // Scan a bounded prefix and keep all original bytes, even across UTF-8 boundaries.
      const start = prefix.toString('latin1', 0, bytesRead);
      const head = /^(?:\xEF\xBB\xBF)?\s*(?:(?:<!doctype\b[^>]*>|<!--[\s\S]*?-->)\s*)*(?:<html\b[^>]*>\s*)?<head\b[^>]*>/i.exec(start);
      const doctype = /^(?:\xEF\xBB\xBF)?\s*<!doctype\b[^>]*>/i.exec(start);
      const offset = head?.[0].length ?? doctype?.[0].length ?? (start.startsWith('\xEF\xBB\xBF') ? 3 : 0);
      response.write(prefix.subarray(0, offset));
      response.write(doctype || head ? bootstrap : `<!doctype html>${bootstrap}`);
      response.write(prefix.subarray(offset, bytesRead));
    }
    if (bytesRead < info.size) await pipeline(handle.createReadStream({ start: bytesRead, end: info.size - 1 }), response);
    else response.end();
  } catch {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Visualization unavailable or changed. Reopen it from the chat.');
    } else if (!response.destroyed) response.destroy();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class InteractivePreviews {
  constructor() { this.entries = new Map(); }
  publish(preview, origin) {
    if (preview.kind !== 'rich' || preview.blockKind !== 'code' || !/^(html|htm)$/i.test(preview.language || '')) return;
    if (!preview.disk) {
      if (!/<(?:html|body|input|button|div|section|main|article|h[1-6]|p|table|ul|ol|img|form|svg|canvas)\b/i.test(preview.text || '')) return;
      if (Buffer.byteLength(preview.text) > 200000) throw new Error('Interactive HTML is limited to 200 KB.');
    }
    let entry = [...this.entries.values()].find(value => value.identity === preview.identity);
    if (!entry) entry = { identity: preview.identity, token: randomUUID(), ...(preview.disk ? { disk: preview.disk } : { text: preview.text }) };
    this.entries.delete(entry.token); this.entries.set(entry.token, entry);
    while (this.entries.size > 12) this.entries.delete(this.entries.keys().next().value);
    return `${origin}/interactive/${entry.token}`;
  }
  async serve(request, response, url, uiOrigin) {
    if (!url.pathname.startsWith('/interactive/')) return false;
    const token = url.pathname.slice('/interactive/'.length), entry = this.entries.get(token);
    if (!entry || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end('Preview expired. Reopen it from the chat.'); return true; }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
      'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${uiOrigin}` };
    const theme = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:dark;font:14px/1.5 Inter,"Segoe UI",system-ui,sans-serif;color:#dedee7;background:#14161c}body{margin:20px}img,svg,canvas{max-width:100%}:where(input,button,select,textarea){font:inherit;accent-color:#b0b4c5}:where(button,select,input:not([type=range],[type=checkbox],[type=radio]),textarea){color:inherit;background:#202027;border:1px solid #ffffff25;padding:4px 8px}:where(button){border-radius:0}:where(:focus-visible){outline:2px solid #b0b4c5;outline-offset:2px}*{box-sizing:border-box}</style>';
    const diagnostics = `<script>(()=>{const send=(kind,message)=>parent.postMessage({type:'mr-mik-preview',kind,message:String(message).slice(0,2000)},'*');addEventListener('error',event=>send('error',event.message||'A local preview resource could not load'),true);addEventListener('unhandledrejection',event=>send('error',event.reason?.message||event.reason));for(const key of ['warn','error']){const original=console[key];console[key]=(...args)=>{send(key,args.map(value=>String(value)).join(' '));original.apply(console,args)}}addEventListener('pointerdown',()=>send('interact','held'));addEventListener('pointerup',()=>send('release',''));addEventListener('pointercancel',()=>send('release',''));addEventListener('blur',()=>send('release',''));addEventListener('keydown',()=>send('interact',''));addEventListener('input',()=>send('interact',''));addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey||!event.deltaY)return;const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?innerHeight:1);const canScroll=event.composedPath().some(node=>node instanceof Element&&node.scrollHeight>node.clientHeight+1&&/auto|scroll/.test(getComputedStyle(node).overflowY)&&(delta<0?node.scrollTop>0:node.scrollTop+node.clientHeight<node.scrollHeight-1));const doc=document.scrollingElement;if(canScroll||doc&&(delta<0?doc.scrollTop>0:doc.scrollTop+innerHeight<doc.scrollHeight-1))return;event.preventDefault();parent.postMessage({type:'mr-mik-preview',kind:'wheel',deltaY:Math.max(-1000,Math.min(1000,delta))},'*')},{passive:false});addEventListener('DOMContentLoaded',()=>send('ready','Preview ready'))})()</script>`;
    if (entry.disk) { await serveDiskPreview(request, response, url, headers, entry.disk, theme + diagnostics); return true; }
    const html = /<head\b[^>]*>/i.test(entry.text) ? entry.text.replace(/<head\b[^>]*>/i, match => match + theme + diagnostics) : `<!doctype html>${theme}${diagnostics}${entry.text}`;
    response.writeHead(200, headers); response.end(request.method === 'HEAD' ? undefined : html); return true;
  }
}
