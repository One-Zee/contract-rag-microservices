import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import { acceptContractFile, createUploadOptions } from './upload.options.js';

const filter = (mimetype: string) => {
  const callback = vi.fn();
  acceptContractFile(
    {},
    { mimetype, originalname: 'x', fieldname: 'file' } as never,
    callback,
  );
  return callback.mock.calls[0] as [Error | null, boolean];
};

describe('acceptContractFile', () => {
  it.each([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ])('accepts %s', (mimetype) => {
    expect(filter(mimetype)).toEqual([null, true]);
  });

  it.each([
    'text/plain',
    'application/octet-stream',
    'application/x-msdownload',
    'application/msword',
    'image/png',
    '',
  ])('refuses %j with 415 before the body is buffered', (mimetype) => {
    const [error, accepted] = filter(mimetype);

    expect(accepted).toBe(false);
    expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
  });
});

describe('createUploadOptions', () => {
  it('takes the size limit from configuration and allows a single file', () => {
    const options = createUploadOptions({
      uploadMaxBytes: 1234,
    } as AppConfigService);

    expect(options.limits).toMatchObject({ fileSize: 1234, files: 1 });
    expect(options.fileFilter).toBe(acceptContractFile);
    // Memory storage: nothing is written to disk on the way to TCP.
    expect(options).not.toHaveProperty('storage');
    expect(options).not.toHaveProperty('dest');
  });
});
