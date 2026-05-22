import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

/**
 * Thin S3/MinIO wrapper. Handles the three bucket quirks we care about in
 * local dev:
 *   1. `forcePathStyle` — MinIO only speaks path-style addressing.
 *   2. Lazy bucket-exists check + auto-create — saves `docker exec`-ing
 *      into MinIO on fresh dev laptops.
 *   3. A singleton client kept on `globalThis` so Next.js HMR doesn't leak
 *      socket pools (same trick we use for Prisma).
 */

const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "minioadmin";
const SECRET_KEY = process.env.S3_SECRET_KEY ?? "minioadmin";
const REGION = process.env.S3_REGION ?? "us-east-1";
export const BUCKET = process.env.S3_BUCKET ?? "assessment-documents";

const globalForS3 = globalThis as unknown as {
  s3Client: S3Client | undefined;
  s3BucketEnsured: boolean | undefined;
};

export const s3 =
  globalForS3.s3Client ??
  new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    forcePathStyle: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForS3.s3Client = s3;
}

/**
 * Idempotently ensure the configured bucket exists. Safe to call on every
 * upload — after the first success we cache a module-level flag.
 */
export async function ensureBucket(): Promise<void> {
  if (globalForS3.s3BucketEnsured) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (err: unknown) {
    // Any HTTP 404 / NotFound / NoSuchBucket → create.
    const code =
      (err as { name?: string; $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode ??
      (err as { name?: string }).name;
    const shouldCreate =
      code === 404 || code === "NotFound" || code === "NoSuchBucket";
    if (!shouldCreate) throw err;
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
  globalForS3.s3BucketEnsured = true;
}

/**
 * Deterministic storage key. Scoping by assessmentId keeps listings
 * cheap and makes bulk-delete-on-assessment-deletion trivial later.
 */
export function buildStorageKey(
  assessmentId: string,
  documentId: string,
  filename: string,
): string {
  // Strip dangerous chars from the filename tail — we keep it mostly to aid
  // debugging; the real identity lives in documentId.
  const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  return `assessments/${assessmentId}/documents/${documentId}/${safeName}`;
}

/**
 * Storage key for an uploaded `Template` row. Keyed off the template
 * id so versioning is just "create a new row + new key" — old keys
 * stay readable for replay.
 */
export function buildTemplateStorageKey(
  templateId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  return `templates/${templateId}/${safeName}`;
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await ensureBucket();
  const input: PutObjectCommandInput = {
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  };
  await s3.send(new PutObjectCommand(input));
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty body for ${key}`);
  // The SDK returns a web-ish stream; normalize to a Buffer.
  const stream = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Stream a stored object as a web ReadableStream. Used by the download
 * proxy route so authz stays server-side (vs. presigned URLs that leak a
 * bearer token to any browser/proxy in the chain).
 */
export async function getObjectStream(key: string): Promise<{
  body: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
}> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty body for ${key}`);
  return {
    body: res.Body as Readable,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
  };
}
