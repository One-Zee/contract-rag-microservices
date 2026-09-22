import { Logger } from '@nestjs/common';
import type { DocumentIndexer, IndexOutcome } from './document-indexer.js';
import type { DocumentsRepository } from './documents.repository.js';
import { IndexingSweep } from './indexing-sweep.js';

Logger.overrideLogger(false);

const setup = (ids: string[]) => {
  const documents = { findIdsByStatus: vi.fn().mockResolvedValue(ids) };
  const indexer = {
    index: vi
      .fn<(id: string) => Promise<IndexOutcome>>()
      .mockResolvedValue({ kind: 'indexed', chunkCount: 1 }),
  };
  const sweep = new IndexingSweep(
    indexer as unknown as DocumentIndexer,
    documents as unknown as DocumentsRepository,
  );
  return { sweep, documents, indexer };
};

describe('IndexingSweep', () => {
  it('indexes every document left in chunked or indexing, one after another', async () => {
    const { sweep, documents, indexer } = setup(['a', 'b', 'c']);
    const order: string[] = [];
    indexer.index.mockImplementation(async (id) => {
      order.push(`start ${id}`);
      await Promise.resolve();
      order.push(`end ${id}`);
      return { kind: 'indexed', chunkCount: 1 };
    });

    await sweep.onApplicationBootstrap();
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(3));
    await sweep.onApplicationShutdown();

    expect(documents.findIdsByStatus).toHaveBeenCalledWith([
      'chunked',
      'indexing',
    ]);
    expect(order).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c',
    ]);
  });

  it('does not block the boot on the sweep', async () => {
    const { sweep, indexer } = setup(['a']);
    let release!: () => void;
    indexer.index.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ kind: 'indexed', chunkCount: 1 });
      }),
    );

    await sweep.onApplicationBootstrap();

    expect(indexer.index).toHaveBeenCalledWith('a');
    release();
    await sweep.onApplicationShutdown();
  });

  it('carries on past a document whose indexing threw', async () => {
    const { sweep, indexer } = setup(['a', 'b']);
    indexer.index
      .mockRejectedValueOnce(new Error('database is down'))
      .mockResolvedValueOnce({ kind: 'indexed', chunkCount: 1 });

    await sweep.onApplicationBootstrap();
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(2));
    await sweep.onApplicationShutdown();

    expect(indexer.index).toHaveBeenCalledTimes(2);
    expect(indexer.index).toHaveBeenLastCalledWith('b');
  });

  it('stops between documents once a shutdown has begun', async () => {
    const { sweep, indexer } = setup(['a', 'b', 'c']);
    let release!: () => void;
    indexer.index.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: 'indexed', chunkCount: 1 });
        }),
    );

    await sweep.onApplicationBootstrap();
    const shutdown = sweep.onApplicationShutdown();
    release();
    await shutdown;

    expect(indexer.index).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing to sweep', async () => {
    const { sweep, indexer } = setup([]);

    await sweep.onApplicationBootstrap();
    await sweep.onApplicationShutdown();

    expect(indexer.index).not.toHaveBeenCalled();
  });
});
