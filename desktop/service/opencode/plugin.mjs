import { observerFromEnvironment, finalAnswerPreview } from './observer.mjs';

export default async function mrMikPlugin({ directory, client }) {
  const observe = observerFromEnvironment(directory, process.env, async (sessionID, messageID) => {
    if (!client?.session?.message) return '';
    const result = await client.session.message({ path: { id: sessionID, messageID }, query: { directory }, signal: AbortSignal.timeout(2000) });
    return finalAnswerPreview(result.data, sessionID, messageID);
  });
  const orientation = process.env.MRMAK_OPENCODE_ORIENTATION;
  return {
    event: async ({ event }) => observe(event),
    'experimental.chat.system.transform': async (_input, output) => {
      if (!orientation || !Array.isArray(output.system)) return;
      // Mutate in place and avoid an extra system-message entry: some
      // OpenAI-compatible providers accept only one leading system message.
      if (!output.system.some(text => text.includes(orientation))) {
        if (output.system.length) output.system[0] += `\n\n${orientation}`;
        else output.system.push(orientation);
      }
    },
  };
}
