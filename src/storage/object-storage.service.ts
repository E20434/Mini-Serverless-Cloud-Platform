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
 * client. Pointing this at real S3 (Phase 13) is a config change
 * (endpoint + credentials), not a code change - which is the entire
 * point of building against object storage instead of a local path from
 * day one.
 */
@Injectable()
export class ObjectStorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly isMinio: boolean;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? 'mini-cloud-function-source';
    const endpoint = process.env.S3_ENDPOINT; // set for MinIO only - real AWS S3 resolves its own regional endpoint automatically
    this.isMinio = Boolean(endpoint);

    this.client = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      // Explicit static credentials for MinIO, which has no IAM concept
      // at all. Omitted entirely for real AWS S3 (Phase 13) - the SDK
      // falls back to its default credential provider chain, which on
      // ECS means the task's own IAM role, resolved automatically via
      // the container credentials endpoint. No long-lived access keys
      // anywhere near this process once it's running on AWS.
      credentials: process.env.S3_ACCESS_KEY_ID
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '' }
        : undefined,
      // Path-style is REQUIRED for MinIO's local URLs; real S3 prefers
      // virtual-hosted style, so this only forces path-style when
      // actually talking to a custom (MinIO) endpoint.
      forcePathStyle: this.isMinio,
    });
  }

  async onModuleInit() {
    if (!this.isMinio) {
      // Real AWS: Terraform already provisioned this bucket (terraform/s3.tf),
      // and the task's IAM role deliberately has no s3:CreateBucket
      // permission at all - least privilege, and there's nothing for
      // this call to legitimately do here anyway. Attempting it would
      // just fail loudly on every single boot.
      return;
    }
    // Unlike real AWS S3, MinIO starts with nothing - so local dev needs
    // the app to ensure its own bucket exists. Swallow "already exists"
    // so this is safe to run on every boot.
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
    for await (const chunk of result.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
