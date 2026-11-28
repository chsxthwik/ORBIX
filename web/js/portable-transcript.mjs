export const TRANSCRIPT_FORMAT = 'orbix-transcript';
export const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

/** A portable transcript is data only. Never import tool calls, paths, credentials or execution state. */
export function portableTranscript(value) {
  if (value?.format !== TRANSCRIPT_FORMAT || value.version !== 1) {
    throw new Error('Choose a portable ORBIX transcript in format version 1.');
  }
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 20000) {
    throw new Error('A portable transcript must contain 1 to 20,000 messages.');
  }
  let chars = 0;
  const messages = value.messages.map((message) => {
    if ((message?.role !== 'user' && message?.role !== 'assistant') || typeof message.text !== 'string' || !message.text.trim()) {
      throw new Error('A portable transcript can contain only user and assistant text messages.');
    }
    chars += message.text.length;
    if (chars > TRANSCRIPT_MAX_BYTES) throw new Error('This portable transcript is too large.');
    return { role: message.role, text: message.text };
  });
  const title = typeof value.title === 'string' ? value.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return { format: TRANSCRIPT_FORMAT, version: 1, title: title || 'Imported conversation', messages };
}
