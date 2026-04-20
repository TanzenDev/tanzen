/**
 * SeaweedFS / S3 client and helpers.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const S3_ENDPOINT   = process.env["S3_ENDPOINT_URL"]    ?? "http://seaweedfs-s3:8333";
const ACCESS_KEY    = process.env["S3_ACCESS_KEY"]       ?? "tanzen";
const SECRET_KEY    = process.env["S3_SECRET_KEY"]       ?? "tanzen";

export const WORKFLOWS_BUCKET = process.env["S3_WORKFLOWS_BUCKET"] ?? "workflows";
export const AGENTS_BUCKET    = process.env["S3_AGENTS_BUCKET"]    ?? "agents";
export const ARTIFACTS_BUCKET = process.env["S3_ARTIFACTS_BUCKET"] ?? "artifacts";
export const SCRIPTS_BUCKET   = process.env["S3_SCRIPTS_BUCKET"]   ?? "scripts";

export const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
});

export async function putObject(bucket: string, key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "application/json",
  }));
}

export async function getObject(bucket: string, key: string): Promise<string> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return resp.Body ? await resp.Body.transformToString() : "";
}

/**
 * Ensure all required S3 buckets exist, creating any that are missing.
 * Idempotent — safe to call on every server startup.
 */
export async function ensureBuckets(): Promise<void> {
  const buckets = [WORKFLOWS_BUCKET, AGENTS_BUCKET, ARTIFACTS_BUCKET, SCRIPTS_BUCKET];
  await Promise.all(buckets.map(async (bucket) => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      // Bucket missing (or any access error) — attempt to create
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        console.log(`s3: created bucket '${bucket}'`);
      } catch (createErr) {
        // Bucket may have been created by another startup race — log and continue
        console.warn(`s3: could not create bucket '${bucket}':`, createErr instanceof Error ? createErr.message : createErr);
      }
    }
  }));
}

export async function presignedGet(bucket: string, key: string, ttlSeconds = 900): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: ttlSeconds },
  );
}
