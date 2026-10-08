import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { MulterModuleOptions } from '@nestjs/platform-express';
import { AppConfigService } from '@app/config';
import { isAcceptedMimeType } from '@app/common';

/** Name of the multipart part that carries the document. */
export const UPLOAD_FIELD = 'file';

/**
 * What multer hands to `@UploadedFile()` with the default memory storage —
 * only the fields the gateway forwards. Declared here rather than pulled from
 * `@types/multer`, which would be a devDependency in production code.
 */
export interface UploadedContractFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Runs before the body is read, so an `.exe` is refused without buffering it.
 * The declared MIME type is the client's word; ingestion-service checks the
 * bytes themselves
 */
export const acceptContractFile: NonNullable<
  MulterModuleOptions['fileFilter']
> = (_request, file, callback) => {
  if (isAcceptedMimeType(file.mimetype)) {
    callback(null, true);
    return;
  }
  callback(
    new UnsupportedMediaTypeException(
      `Unsupported file type ${file.mimetype}; upload a PDF or DOCX`,
    ),
    false,
  );
};

/**
 * Module-level multer options; `FileInterceptor` merges them with its own.
 * No `storage`/`dest` means memory storage — the buffer goes straight into
 * the TCP payload. `LIMIT_FILE_SIZE` becomes a 413 through Nest's own mapping.
 */
export const createUploadOptions = (
  config: AppConfigService,
): MulterModuleOptions => ({
  limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 5 },
  fileFilter: acceptContractFile,
});
