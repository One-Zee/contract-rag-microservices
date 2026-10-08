export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Server-sent events from a fetch body: blank-line separated blocks of
 * `field: value` lines. `data` lines join with a newline; `id`, `retry` and
 * comments carry nothing the harness needs.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const parsed = parseBlock(block);
      if (parsed) {
        yield parsed;
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
  const last = parseBlock(buffer);
  if (last) {
    yield last;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}
