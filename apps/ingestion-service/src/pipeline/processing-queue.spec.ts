import { Logger } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import type { DocumentsRepository } from '../documents/documents.repository.js';
import type { IngestionPipeline } from './ingestion-pipeline.js';
import { ProcessingQueue } from './processing-queue.js';

Logger.overrideLogger(false);

/** A pipeline whose runs finish only when the test says so. */
const controllablePipeline = () => {
  const resolvers = new Map<string, () => void>();
  const rejecters = new Map<string, (error: Error) => void>();
  const started: string[] = [];
  const process = vi.fn(
    (id: string) =>
      new Promise<void>((resolve, reject) => {
        started.push(id);
        resolvers.set(id, resolve);
        rejecters.set(id, reject);
      }),
  );
  const finish = async (id: string) => {
    resolvers.get(id)!();
    await new Promise((r) => setImmediate(r));
  };
  const fail = async (id: string) => {
    rejecters.get(id)!(new Error(`boom ${id}`));
    await new Promise((r) => setImmediate(r));
  };
  return { process, started, finish, fail };
};

const setup = (concurrency = 2, unfinished: string[] = []) => {
  const pipeline = controllablePipeline();
  const documents = { findIdsByStatus: vi.fn().mockResolvedValue(unfinished) };
  const config = { ingestionConcurrency: concurrency } as AppConfigService;
  const queue = new ProcessingQueue(
    pipeline as unknown as IngestionPipeline,
    documents as unknown as DocumentsRepository,
    config,
  );
  return { queue, pipeline, documents };
};

describe('ProcessingQueue', () => {
  it('never runs more documents than the configured concurrency', async () => {
    const { queue, pipeline } = setup(2);

    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');

    expect(pipeline.started).toEqual(['a', 'b']);
    expect(queue.size).toBe(3);

    await pipeline.finish('a');
    expect(pipeline.started).toEqual(['a', 'b', 'c']);

    await pipeline.finish('b');
    await pipeline.finish('c');
    expect(queue.size).toBe(0);
  });

  it('keeps draining when a run rejects', async () => {
    const { queue, pipeline } = setup(1);

    queue.enqueue('a');
    queue.enqueue('b');
    await pipeline.fail('a');

    expect(pipeline.started).toEqual(['a', 'b']);
    await pipeline.finish('b');
    expect(queue.size).toBe(0);
  });

  it('ignores an id that is already waiting or running', async () => {
    const { queue, pipeline } = setup(1);

    queue.enqueue('a');
    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('b');

    expect(queue.size).toBe(2);
    await pipeline.finish('a');
    await pipeline.finish('b');
    expect(pipeline.process).toHaveBeenCalledTimes(2);
  });

  it('re-queues the documents a previous run left unfinished, at boot', async () => {
    const { queue, pipeline, documents } = setup(5, ['old-1', 'old-2']);

    await queue.onApplicationBootstrap();

    expect(documents.findIdsByStatus).toHaveBeenCalledWith([
      'uploaded',
      'parsing',
    ]);
    expect(pipeline.started).toEqual(['old-1', 'old-2']);
  });

  it('waits for the documents in flight on shutdown', async () => {
    const { queue, pipeline } = setup(2);
    queue.enqueue('a');

    let settled = false;
    const shutdown = queue.onApplicationShutdown().then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    await pipeline.finish('a');
    await shutdown;
    expect(settled).toBe(true);
  });
});
