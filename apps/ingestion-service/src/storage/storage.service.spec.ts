import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import { StorageService, storageKeyFor } from './storage.service.js';

Logger.overrideLogger(false);

const notFound = (name = 'NotFound') =>
  new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
  });

const setup = () => {
  const send = vi.fn();
  const client = { send, destroy: vi.fn() };
  const config = { s3Bucket: 'contracts' } as AppConfigService;
  const service = new StorageService(config, client as unknown as S3Client);
  return { service, send, client };
};

const commandsSent = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map(([command]) => command.constructor);

describe('storageKeyFor', () => {
  it('derives the key from the document id and MIME type only', () => {
    expect(storageKeyFor('doc-1', 'application/pdf')).toBe(
      'documents/doc-1/original.pdf',
    );
    expect(
      storageKeyFor(
        'doc-2',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('documents/doc-2/original.docx');
  });
});

describe('StorageService', () => {
  describe('onModuleInit', () => {
    it('leaves an existing bucket alone', async () => {
      const { service, send } = setup();
      send.mockResolvedValue({});

      await service.onModuleInit();

      expect(commandsSent(send)).toEqual([HeadBucketCommand]);
    });

    it('creates the bucket when it does not exist', async () => {
      const { service, send } = setup();
      send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

      await service.onModuleInit();

      expect(commandsSent(send)).toEqual([
        HeadBucketCommand,
        CreateBucketCommand,
      ]);
      expect(send.mock.calls[1][0].input).toEqual({ Bucket: 'contracts' });
    });

    it('fails the boot on any other error — wrong credentials, store down', async () => {
      const { service, send } = setup();
      send.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.onModuleInit()).rejects.toThrow('ECONNREFUSED');
      expect(commandsSent(send)).toEqual([HeadBucketCommand]);
    });
  });

  it('stores the body with its content type under the given key', async () => {
    const { service, send } = setup();
    send.mockResolvedValue({});

    await service.put(
      'documents/d/original.pdf',
      Buffer.from('abc'),
      'application/pdf',
    );

    const [command] = send.mock.calls[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'contracts',
      Key: 'documents/d/original.pdf',
      ContentType: 'application/pdf',
      ContentLength: 3,
    });
  });

  it('reads an object back as a Buffer', async () => {
    const { service, send } = setup();
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });

    const body = await service.get('documents/d/original.pdf');

    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(body).toEqual(Buffer.from([1, 2, 3]));
  });

  it('deletes by key', async () => {
    const { service, send } = setup();
    send.mockResolvedValue({});

    await service.delete('documents/d/original.pdf');

    const [command] = send.mock.calls[0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'contracts',
      Key: 'documents/d/original.pdf',
    });
  });

  it('answers exists() with false for a missing key and rethrows anything else', async () => {
    const { service, send } = setup();
    send.mockResolvedValueOnce({});
    send.mockRejectedValueOnce(notFound('NoSuchKey'));
    send.mockRejectedValueOnce(new Error('timeout'));

    await expect(service.exists('a')).resolves.toBe(true);
    await expect(service.exists('b')).resolves.toBe(false);
    await expect(service.exists('c')).rejects.toThrow('timeout');
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('destroys the client on shutdown', () => {
    const { service, client } = setup();

    service.onApplicationShutdown();

    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});
