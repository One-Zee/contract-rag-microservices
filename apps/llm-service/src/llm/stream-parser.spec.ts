import {
  decodeText,
  idleAbort,
  iterateJsonLines,
  iterateSseData,
} from './stream-parser.js';

const encoder = new TextEncoder();

/** A body that hands over exactly the pieces given, in order. */
const bodyOf = (
  ...pieces: (string | Uint8Array)[]
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const piece of pieces) {
      yield typeof piece === 'string' ? encoder.encode(piece) : piece;
      // Let the consumer run between pieces, as a socket would.
      await Promise.resolve();
    }
  },
});

const collect = async (source: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
};

describe('decodeText', () => {
  it('holds back a multi-byte character split across chunks', async () => {
    const bytes = encoder.encode('ugovor — član');
    const split = bytes.indexOf(0xe2) + 1; // mid "—"

    const parts = await collect(
      decodeText(bodyOf(bytes.slice(0, split), bytes.slice(split))),
    );

    expect(parts.join('')).toBe('ugovor — član');
  });

  it('strips a leading byte order mark', async () => {
    const parts = await collect(decodeText(bodyOf('﻿{"a":1}')));

    expect(parts.join('')).toBe('{"a":1}');
  });
});

describe('iterateSseData', () => {
  it('parses one event delivered in a single chunk', async () => {
    const events = await collect(
      iterateSseData(bodyOf('event: ping\ndata: {"type":"ping"}\n\n')),
    );

    expect(events).toEqual(['{"type":"ping"}']);
  });

  it('parses an event split across three chunks, mid-JSON', async () => {
    const events = await collect(
      iterateSseData(
        bodyOf(
          'event: content_block_delta\nda',
          'ta: {"type":"conte',
          'nt_block_delta"}\n\n',
        ),
      ),
    );

    expect(events).toEqual(['{"type":"content_block_delta"}']);
  });

  it('accepts CRLF framing', async () => {
    const events = await collect(
      iterateSseData(bodyOf('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n')),
    );

    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('joins several data lines with a newline and skips comments', async () => {
    const events = await collect(
      iterateSseData(
        bodyOf(': keep-alive\ndata: line one\ndata: line two\n\n'),
      ),
    );

    expect(events).toEqual(['line one\nline two']);
  });

  it('strips exactly one space after the colon', async () => {
    const events = await collect(iterateSseData(bodyOf('data:  padded\n\n')));

    expect(events).toEqual([' padded']);
  });

  it('yields nothing for a frame that carries no data line', async () => {
    const events = await collect(iterateSseData(bodyOf('event: ping\n\n')));

    expect(events).toEqual([]);
  });

  // An SSE event is only an event once its blank line has arrived; a stream
  // cut mid-frame must not deliver half a JSON document to `JSON.parse`.
  it('drops a trailing partial frame', async () => {
    const events = await collect(
      iterateSseData(bodyOf('data: {"a":1}\n\ndata: {"a":2', '')),
    );

    expect(events).toEqual(['{"a":1}']);
  });
});

describe('iterateJsonLines', () => {
  it('parses lines split across chunk boundaries', async () => {
    const lines = await collect(
      iterateJsonLines(bodyOf('{"done":fal', 'se}\n{"done":true}\n')),
    );

    expect(lines).toEqual(['{"done":false}', '{"done":true}']);
  });

  it('tolerates CRLF and blank lines', async () => {
    const lines = await collect(
      iterateJsonLines(bodyOf('{"a":1}\r\n\r\n{"a":2}\r\n')),
    );

    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  // The opposite of the SSE rule: here the newline separates rather than
  // terminates, so a last object with nothing after it is still an object.
  it('yields a final line that has no newline after it', async () => {
    const lines = await collect(iterateJsonLines(bodyOf('{"a":1}\n{"a":2}')));

    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });
});

describe('idleAbort', () => {
  it('aborts after the configured silence', async () => {
    const idle = idleAbort(20);
    idle.touch();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(idle.signal.aborted).toBe(true);
    expect((idle.signal.reason as DOMException).name).toBe('TimeoutError');
    idle.dispose();
  });

  it('does not abort while fragments keep arriving', async () => {
    const idle = idleAbort(40);
    idle.touch();

    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      idle.touch();
    }

    expect(idle.signal.aborted).toBe(false);
    idle.dispose();
  });

  it('follows an external signal that is already aborted', () => {
    const external = AbortSignal.abort(new Error('client left'));
    const idle = idleAbort(1000, external);

    expect(idle.signal.aborted).toBe(true);
    idle.dispose();
  });

  it('follows an external signal that aborts later', () => {
    const controller = new AbortController();
    const idle = idleAbort(1000, controller.signal);
    expect(idle.signal.aborted).toBe(false);

    controller.abort(new Error('client left'));

    expect(idle.signal.aborted).toBe(true);
    idle.dispose();
  });
});
