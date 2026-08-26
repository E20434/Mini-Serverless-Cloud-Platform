import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, OnModuleInit } from '@nestjs/common';

/**
 * A thin wrapper around the S3 API - pointed at MinIO for local dev via
 * S3_ENDPOINT, but this is the ACTUAL AWS SDK, not a MinIO-specific
 * client. Pointing this at real S3 in production is a config change
 * (endpoint + credentials), not a code change - which is the entire
 * point of building against object storage instead of a local path from
 * day one.
 */
@Injectable()
export class ObjectStorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? 'mini-cloud-function-source';
    this.client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
      // MinIO's bucket URLs are path-style (http://host:9000/bucket/key)
      // rather than the virtual-hosted-style (http://bucket.host/key)
      // real AWS S3 defaults to. Real S3 also accepts path-style, so this
      // setting is safe to leave on even against production AWS.
      forcePathStyle: true,
    });
  }

  async onModuleInit() {
    // Unlike real AWS S3 (where a bucket is provisioned once via
    // Terraform/console, never by the application itself), MinIO starts
    // with nothing - so local dev needs the app to ensure its own bucket
    // exists. Swallow "already exists" so this is safe to run on every
    // boot.
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const code = (err as { name?: string }).name;
      if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
        throw err;
      }
    }
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const chunks: Buffer[] = [];
    // The SDK's Body is a Node.js Readable stream in this environment -
    // it has to be drained manually into a Buffer, there's no
    // `.toBuffer()` convenience on the response itself.
    for await (const chunk of result.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
