import { v2ObserverFromEnvironment } from './v2-observer.mjs';

// Plugin.define is an identity helper in V2; a plain definition avoids depending
// on a separately installed SDK when this file is loaded by the native CLI.
export default {
  id: 'mr-mik-workspace-v2',
  async setup(ctx) {
    const directory = ctx.location?.directory;
    if (!directory || typeof ctx.session?.hook !== 'function' || typeof ctx.event?.subscribe !== 'function') throw new Error('Mr. Mik requires the OpenCode V2 context/event plugin contracts.');
    const observe = v2ObserverFromEnvironment(directory);
    const orientation = process.env.MRMAK_OPENCODE_ORIENTATION;
    const controller = new AbortController();
    const events = (async () => { for await (const event of ctx.event.subscribe({ signal: controller.signal })) observe(event); })();
    events.catch(() => { /* Observation failure must not replay requests. */ });
    // Register before any model request. Never inject a synthetic user message.
    let hook;
    try { hook = await ctx.session.hook('context', event => {
      if (!orientation || !observe.owns(event.sessionID) || !Array.isArray(event.system)) return;
      if (event.system.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.includes(orientation))) return;
      const first = event.system.find(part => part.type === 'text' && typeof part.text === 'string');
      if (first) first.text += `\n\n${orientation}`;
      else event.system.push({ type: 'text', text: orientation });
    }); } catch (error) { controller.abort(); await events.catch(() => {}); observe.dispose?.(); throw error; }
    return async () => { controller.abort(); await hook.dispose(); await events.catch(() => {}); observe.dispose?.(); };
  },
};
