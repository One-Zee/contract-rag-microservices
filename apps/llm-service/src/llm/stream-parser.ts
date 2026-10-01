/**
 * Framing for streamed HTTP bodies. Pure — it takes an async iterable of bytes
 * and yields complete units — so the rubbish cases (a frame split across three
 * TCP segments, a multi-byte character split down the middle, `\r\n` instead
 * of `\n`) get unit tests that need neither a network nor a provider.
 *
 * Both providers need this and neither can assume the other's framing:
 * Anthropic speaks SSE, Ollama speaks NDJSON.
 */

/** Earliest of the three frame separators the SSE spec allows. */
const SSE_FRAME_END = /\r\n\r\n|\n\n|\r\r/;
const LINE_END = /\r\n|\n|\r/;

/**
 * Bytes to text, incrementally. `TextDecoder` with `stream: true` holds back a
 * partial multi-byte character until its remaining bytes arrive, which is the
 * whole reason this is not `chunk.toString()`. It also strips a leading BOM,
 * since `ignoreBOM` defaults to false.
 */
export async function* decodeText(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) {
      yield text;
    }
  }
  const tail = decoder.decode();
  if (tail) {
    yield tail;
  }
}

/**
 * The `data` payload of each complete SSE event.
 *
 * `event:` lines are deliberately ignored: Anthropic repeats the discriminator
 * inside the JSON as `type`, and trusting one source rather than two removes a
 * class of bug where the two disagree. `:` comment lines and unknown fields are
 * skipped; several `data:` lines in one frame are joined with a newline, as the
 * spec requires.
 *
 * A trailing partial frame is dropped rather than yielded: an SSE event is only
 * an event once its blank line has arrived.
 */
export async function* iterateSseData(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  let buffer = '';

  for await (const text of decodeText(source)) {
    buffer += text;
    for (;;) {
      const match = SSE_FRAME_END.exec(buffer);
      if (!match) {
        break;
      }
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = readDataLines(frame);
      if (data !== null) {
        yield data;
      }
    }
  }
}

const readDataLines = (frame: string): string | null => {
  const payloads: string[] = [];
  for (const line of frame.split(LINE_END)) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      // The spec strips exactly one space after the colon, not all whitespace.
      const value = line.slice(5);
      payloads.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  return payloads.length > 0 ? payloads.join('\n') : null;
};

/**
 * One JSON document per line (NDJSON), as Ollama streams.
 *
 * Unlike SSE, a final line with no newline after it *is* yielded: the newline
 * is a separator here, not a terminator, and a server that closes the
 * connection straight after the last object has still sent a whole object.
 */
export async function* iterateJsonLines(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  let buffer = '';

  for await (const text of decodeText(source)) {
    buffer += text;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) {
        break;
      }
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        yield line;
      }
    }
  }

  const last = buffer.trim();
  if (last.length > 0) {
    yield last;
  }
}

export interface IdleAbort {
  signal: AbortSignal;
  /** Call on every fragment received; restarts the clock. */
  touch: () => void;
  /** Always call, in a `finally` — an un-cleared timer keeps the process awake. */
  dispose: () => void;
}

/**
 * Aborts after `ms` of *silence*, not after `ms` in total.
 *
 * A total timeout (`AbortSignal.timeout`, as the embedding and rerank clients
 * use) is wrong for generation: a long answer is not a hung one, and cutting
 * it off at thirty seconds would truncate exactly the thorough answers. What
 * actually indicates a hang is a stream that has stopped producing.
 *
 * An external signal — the caller giving up, or the client disconnecting —
 * is chained in, so one signal reaches `fetch` and the body reader.
 */
export const idleAbort = (ms: number, external?: AbortSignal): IdleAbort => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => {
    controller.abort(external?.reason);
  };

  const dispose = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    external?.removeEventListener('abort', onExternalAbort);
  };

  const touch = () => {
    if (controller.signal.aborted) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      controller.abort(new DOMException(`No data for ${ms}ms`, 'TimeoutError'));
    }, ms);
    // Node-only, and absent under other runtimes: a pending timer must not be
    // the reason the process refuses to exit.
    timer.unref?.();
  };

  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return { signal: controller.signal, touch, dispose };
};
