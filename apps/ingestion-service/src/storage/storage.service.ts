import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { AppConfigService } from '@app/config';
import { ACCEPTED_DOCUMENT_TYPES, type AcceptedMimeType } from '@app/common';

export const S3_CLIENT = Symbol('S3_CLIENT');

export const createS3Client = (config: AppConfigService): S3Client =>
  new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
  });

/**
 * The original file lives under a key derived from the document id alone —
 * never from the user-supplied file name, which stays in the database as
 * `original_filename`. One document, one object, no path traversal.
 */
export const storageKeyFor = (
  documentId: string,
  mimeType: AcceptedMimeType,
): string =>
  `documents/${documentId}/original.${ACCEPTED_DOCUMENT_TYPES[mimeType]}`;

const isNotFound = (error: unknown): boolean =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 404 ||
    error.name === 'NotFound' ||
    error.name === 'NoSuchBucket' ||
    error.name === 'NoSuchKey');

/**
 * Object storage for the originals (MinIO in development, any S3-compatible
 * store in production). The bucket is the source of truth for processing:
 * the pipeline always reads the file back from here, so an upload, a retry
 * and a crash recovery all take the same path.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;

  constructor(
    config: AppConfigService,
    @Inject(S3_CLIENT) private readonly client: S3Client,
  ) {
    this.bucket = config.s3Bucket;
  }

  /**
   * Fails the boot when the store is unreachable, and creates the bucket
   * when it is missing — in development nothing else would. A production
   * deployment pre-creates it with scoped credentials, and then this is only
   * the `HeadBucket` check.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket "${this.bucket}"`);
    }
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`Object ${key} has no body`);
    }
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }
}
