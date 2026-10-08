import { Logger } from '@nestjs/common';
import type { RpcException } from '@nestjs/microservices';
import type { AppConfigService } from '@app/config';
import type {
  AuthContext,
  RpcErrorShape,
  UploadDocumentRpcPayload,
  UserRoleName,
} from '@app/common';
import type { ProcessingQueue } from '../pipeline/processing-queue.js';
import type { StorageService } from '../storage/storage.service.js';
import type { ChunksRepository } from './chunks.repository.js';
import type {
  DocumentRecord,
  DocumentsRepository,
} from './documents.repository.js';
import {
  base64LengthFor,
  DocumentsService,
  sanitizeFilename,
} from './documents.service.js';

Logger.overrideLogger(false);

const PDF = 'application/pdf';
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 1_000;

const pdfBytes = (size = 20) =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(size, 'a')]).subarray(
    0,
    size,
  );

const as = (role: UserRoleName, userId = 'u-me'): AuthContext => ({
  userId,
  email: `${userId}@x.ba`,
  roles: [role],
});

const aDocument = (
  overrides: Partial<DocumentRecord> = {},
): DocumentRecord => ({
  id: 'doc-1',
  title: 'MSA',
  originalFilename: 'msa.pdf',
  storageKey: 'documents/doc-1/original.pdf',
  mimeType: PDF,
  fileSize: 20,
  status: 'chunked',
  visibility: 'private',
  pageCount: 3,
  errorMessage: null,
  uploadedBy: 'u-me',
  createdAt: new Date('2026-09-14T00:00:00Z'),
  updatedAt: new Date('2026-09-14T00:00:00Z'),
  ...overrides,
});

const anUpload = (
  overrides: Partial<UploadDocumentRpcPayload> = {},
): UploadDocumentRpcPayload => ({
  accessToken: 'jwt',
  originalFilename: 'msa.pdf',
  mimeType: PDF,
  contentBase64: pdfBytes().toString('base64'),
  ...overrides,
});

const errorOf = (e: unknown) => (e as RpcException).getError() as RpcErrorShape;

const setup = (existing: DocumentRecord | null = aDocument()) => {
  const documents = {
    create: vi.fn(async (input: Partial<DocumentRecord>) =>
      aDocument({ ...input, status: 'uploaded' }),
    ),
    findById: vi.fn().mockResolvedValue(existing ?? undefined),
    list: vi.fn().mockResolvedValue({ items: [aDocument()], total: 1 }),
    update: vi.fn(async (_id: string, patch: Partial<DocumentRecord>) =>
      aDocument(patch),
    ),
    delete: vi.fn().mockResolvedValue(true),
  };
  const chunks = { countForDocument: vi.fn().mockResolvedValue(7) };
  const storage = {
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const queue = { enqueue: vi.fn() };
  const config = { uploadMaxBytes: MAX_BYTES } as AppConfigService;
  const service = new DocumentsService(
    documents as unknown as DocumentsRepository,
    chunks as unknown as ChunksRepository,
    storage as unknown as StorageService,
    queue as unknown as ProcessingQueue,
    config,
  );
  return { service, documents, chunks, storage, queue };
};

describe('helpers', () => {
  it('base64LengthFor is the exact ceiling for n bytes', () => {
    for (const n of [0, 1, 2, 3, 4, 100, 1_000]) {
      expect(base64LengthFor(n)).toBe(
        Buffer.alloc(n).toString('base64').length,
      );
    }
  });

  it('sanitizeFilename keeps only a clean base name', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\a\\contract.pdf')).toBe('contract.pdf');
    expect(sanitizeFilename('  ugovor\u0007.docx ')).toBe('ugovor.docx');
    expect(sanitizeFilename('////')).toBe('');
    expect(sanitizeFilename('x'.repeat(300)).length).toBe(255);
  });
});

describe('DocumentsService.upload', () => {
  it('stores the file, creates the row and queues the processing', async () => {
    const { service, documents, storage, queue } = setup();

    const dto = await service.upload(
      as('analyst'),
      anUpload({ title: '  MSA 2026 ' }),
    );

    const [key, body, contentType] = storage.put.mock.calls[0];
    expect(key).toMatch(/^documents\/[0-9a-f-]{36}\/original\.pdf$/);
    expect(body).toEqual(pdfBytes());
    expect(contentType).toBe(PDF);

    expect(documents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: key,
        title: 'MSA 2026',
        originalFilename: 'msa.pdf',
        mimeType: PDF,
        fileSize: 20,
        visibility: 'private',
        uploadedBy: 'u-me',
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith(
      documents.create.mock.calls[0][0].id,
    );
    expect(dto.status).toBe('uploaded');
    expect(dto).not.toHaveProperty('storageKey');
  });

  it('derives the title from the file name when none is given', async () => {
    const { service, documents } = setup();

    await service.upload(
      as('analyst'),
      anUpload({ originalFilename: 'Ugovor o djelu.pdf' }),
    );

    expect(documents.create.mock.calls[0][0].title).toBe('Ugovor o djelu');
  });

  it('keeps the owner from the verified token, never from the payload', async () => {
    const { service, documents } = setup();

    await service.upload(as('analyst', 'u-real'), {
      ...anUpload(),
      uploadedBy: 'u-forged',
    } as UploadDocumentRpcPayload);

    expect(documents.create.mock.calls[0][0].uploadedBy).toBe('u-real');
  });

  it('rejects an unsupported type with 415 before touching storage', async () => {
    const { service, storage } = setup();

    await expect(
      service.upload(as('analyst'), anUpload({ mimeType: 'text/plain' })),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 415);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects an oversized payload with 413 from the encoded length, before decoding', async () => {
    const { service, storage } = setup();
    const tooLong = 'A'.repeat(base64LengthFor(MAX_BYTES) + 4);
    const fromSpy = vi.spyOn(Buffer, 'from');

    await expect(
      service.upload(as('analyst'), anUpload({ contentBase64: tooLong })),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 413);

    expect(fromSpy).not.toHaveBeenCalledWith(tooLong, 'base64');
    expect(storage.put).not.toHaveBeenCalled();
    fromSpy.mockRestore();
  });

  it('rejects a file just over the byte limit with 413', async () => {
    const { service } = setup();
    const bytes = pdfBytes(MAX_BYTES + 1);

    await expect(
      service.upload(
        as('analyst'),
        anUpload({ contentBase64: bytes.toString('base64') }),
      ),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 413);
  });

  it('accepts a file exactly at the byte limit', async () => {
    const { service } = setup();
    const bytes = pdfBytes(MAX_BYTES);

    await expect(
      service.upload(
        as('analyst'),
        anUpload({ contentBase64: bytes.toString('base64') }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects an empty file with 400', async () => {
    const { service } = setup();

    await expect(
      service.upload(as('analyst'), anUpload({ contentBase64: '' })),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
  });

  it('rejects content whose bytes do not match the declared type with 400', async () => {
    const { service, storage } = setup();
    const text = Buffer.from('plain text pretending to be a pdf');

    await expect(
      service.upload(
        as('analyst'),
        anUpload({ contentBase64: text.toString('base64') }),
      ),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
    await expect(
      service.upload(
        as('analyst'),
        anUpload({
          mimeType: DOCX,
          contentBase64: pdfBytes().toString('base64'),
        }),
      ),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects a file name that sanitises to nothing', async () => {
    const { service } = setup();

    await expect(
      service.upload(as('analyst'), anUpload({ originalFilename: '/' })),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
  });

  it('strips directories from the file name', async () => {
    const { service, documents } = setup();

    await service.upload(
      as('analyst'),
      anUpload({ originalFilename: '../../etc/msa.pdf' }),
    );

    expect(documents.create.mock.calls[0][0].originalFilename).toBe('msa.pdf');
  });

  it('rejects an unknown visibility with 400', async () => {
    const { service } = setup();

    await expect(
      service.upload(as('analyst'), {
        ...anUpload(),
        visibility: 'public' as never,
      }),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
  });

  it('removes the stored object again when the row cannot be created', async () => {
    const { service, documents, storage, queue } = setup();
    documents.create.mockRejectedValue(new Error('connection lost'));

    await expect(service.upload(as('analyst'), anUpload())).rejects.toThrow(
      'connection lost',
    );

    expect(storage.delete).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe('DocumentsService reads', () => {
  it('returns a readable document without its storage key', async () => {
    const { service } = setup(aDocument({ visibility: 'shared' }));

    const dto = await service.get(as('reader', 'u-other'), 'doc-1');

    expect(dto.id).toBe('doc-1');
    expect(dto).not.toHaveProperty('storageKey');
  });

  it('answers 404, not 403, for a private document of someone else', async () => {
    const { service } = setup(
      aDocument({ visibility: 'private', uploadedBy: 'u-other' }),
    );

    await expect(service.get(as('analyst'), 'doc-1')).rejects.toSatisfy(
      (e) => errorOf(e).statusCode === 404,
    );
    await expect(service.get(as('reader'), 'doc-1')).rejects.toSatisfy(
      (e) => errorOf(e).statusCode === 404,
    );
  });

  it('lets an admin read anything', async () => {
    const { service } = setup(
      aDocument({ visibility: 'private', uploadedBy: 'u-other' }),
    );

    await expect(service.get(as('admin'), 'doc-1')).resolves.toBeDefined();
  });

  it('answers 404 for an id that does not exist', async () => {
    const { service } = setup(null);

    await expect(service.get(as('admin'), 'nope')).rejects.toSatisfy(
      (e) => errorOf(e).statusCode === 404,
    );
  });

  it('reports status with the live chunk count', async () => {
    const { service, chunks } = setup();

    const status = await service.status(as('analyst'), 'doc-1');

    expect(chunks.countForDocument).toHaveBeenCalledWith('doc-1');
    expect(status).toEqual({
      id: 'doc-1',
      status: 'chunked',
      pageCount: 3,
      chunkCount: 7,
      errorMessage: null,
      updatedAt: new Date('2026-09-14T00:00:00Z'),
    });
  });

  it('lists through the repository with the caller as viewer and echoes the paging', async () => {
    const { service, documents } = setup();
    const viewer = as('reader');

    const page = await service.list(viewer, {
      accessToken: 'jwt',
      page: 2,
      limit: 10,
      status: 'chunked',
    });

    expect(documents.list).toHaveBeenCalledWith({
      viewer,
      status: 'chunked',
      page: 2,
      limit: 10,
    });
    expect(page).toMatchObject({ total: 1, page: 2, limit: 10 });
    expect(page.items[0]).not.toHaveProperty('storageKey');
  });

  it.each([
    { page: 0, limit: 10 },
    { page: 1, limit: 0 },
    { page: 1, limit: 101 },
    { page: 1.5, limit: 10 },
  ])('rejects paging %j with 400', async ({ page, limit }) => {
    const { service } = setup();

    await expect(
      service.list(as('reader'), { accessToken: 'jwt', page, limit }),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
  });

  it('rejects an unknown status filter with 400', async () => {
    const { service } = setup();

    await expect(
      service.list(as('reader'), {
        accessToken: 'jwt',
        page: 1,
        limit: 10,
        status: 'done' as never,
      }),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
  });
});

describe('DocumentsService.update', () => {
  it('lets the owner change title and visibility', async () => {
    const { service, documents } = setup();

    await service.update(as('analyst'), {
      accessToken: 'jwt',
      documentId: 'doc-1',
      title: ' New title ',
      visibility: 'shared',
    });

    expect(documents.update).toHaveBeenCalledWith('doc-1', {
      title: 'New title',
      visibility: 'shared',
    });
  });

  it('forbids a non-owner analyst on a shared document (403, nothing written)', async () => {
    const { service, documents } = setup(
      aDocument({ visibility: 'shared', uploadedBy: 'u-other' }),
    );

    await expect(
      service.update(as('analyst'), {
        accessToken: 'jwt',
        documentId: 'doc-1',
        visibility: 'private',
      }),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 403);
    expect(documents.update).not.toHaveBeenCalled();
  });

  it('forbids a reader even on a shared document', async () => {
    const { service } = setup(aDocument({ visibility: 'shared' }));

    await expect(
      service.update(as('reader'), {
        accessToken: 'jwt',
        documentId: 'doc-1',
        title: 'x',
      }),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 403);
  });

  it('rejects an empty patch and an empty title with 400', async () => {
    const { service } = setup();

    await expect(
      service.update(as('analyst'), {
        accessToken: 'jwt',
        documentId: 'doc-1',
      }),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
    await expect(
      service.update(as('analyst'), {
        accessToken: 'jwt',
        documentId: 'doc-1',
        title: '   ',
      }),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 400);
  });
});

describe('DocumentsService.delete', () => {
  it('removes the object first, then the row, for the owner', async () => {
    const { service, documents, storage } = setup();

    await service.delete(as('analyst'), 'doc-1');

    expect(storage.delete).toHaveBeenCalledWith('documents/doc-1/original.pdf');
    expect(documents.delete).toHaveBeenCalledWith('doc-1');
    expect(storage.delete.mock.invocationCallOrder[0]).toBeLessThan(
      documents.delete.mock.invocationCallOrder[0],
    );
  });

  it("lets an admin delete anyone's document", async () => {
    const { service, documents } = setup(aDocument({ uploadedBy: 'u-other' }));

    await service.delete(as('admin'), 'doc-1');

    expect(documents.delete).toHaveBeenCalledWith('doc-1');
  });

  it('forbids a non-owner analyst (403) and hides a private document (404), touching nothing', async () => {
    const shared = setup(
      aDocument({ visibility: 'shared', uploadedBy: 'u-other' }),
    );
    await expect(
      shared.service.delete(as('analyst'), 'doc-1'),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 403);

    const hidden = setup(
      aDocument({ visibility: 'private', uploadedBy: 'u-other' }),
    );
    await expect(
      hidden.service.delete(as('analyst'), 'doc-1'),
    ).rejects.toSatisfy((e) => errorOf(e).statusCode === 404);

    for (const { storage, documents } of [shared, hidden]) {
      expect(storage.delete).not.toHaveBeenCalled();
      expect(documents.delete).not.toHaveBeenCalled();
    }
  });

  it('keeps the row when the store refuses to delete the object', async () => {
    const { service, documents, storage } = setup();
    storage.delete.mockRejectedValue(new Error('store down'));

    await expect(service.delete(as('analyst'), 'doc-1')).rejects.toThrow(
      'store down',
    );
    expect(documents.delete).not.toHaveBeenCalled();
  });
});
