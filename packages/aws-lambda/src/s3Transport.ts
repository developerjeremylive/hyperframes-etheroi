/**
 * Thin S3 transport for the Lambda handler.
 *
 * The OSS distributed primitives are pure functions over local file paths;
 * the Lambda handler bridges S3 ↔ Lambda's `/tmp` filesystem on each
 * invocation. Functions here are intentionally narrow: parse a URI, download
 * an object to a local path, upload a path/directory, tar-extract a planDir,
 * tar-pack a planDir back out.
 *
 * Tar (not zip) for planDir transit:
 *   - planDirs contain symlinks (extract stage materializes them but the
 *     compiled/ subtree may include linked assets); tar preserves them, zip
 *     does not.
 *   - We shell out to the system `tar` binary — Lambda's Amazon Linux
 *     runtime ships GNU tar, and the same binary covers local Docker RIE
 *     tests and CI.
 */

import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

/** Parsed `s3://bucket/key` URI. */
export interface S3Location {
  bucket: string;
  key: string;
}

/** Parse `s3://bucket/key/path` → `{ bucket, key }`. Throws on malformed input. */
export function parseS3Uri(uri: string): S3Location {
  if (!uri.startsWith("s3://")) {
    throw new Error(`[s3Transport] expected s3:// URI, got: ${JSON.stringify(uri)}`);
  }
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    throw new Error(`[s3Transport] missing key in s3 URI: ${JSON.stringify(uri)}`);
  }
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!bucket || !key) {
    throw new Error(`[s3Transport] empty bucket or key in s3 URI: ${JSON.stringify(uri)}`);
  }
  return { bucket, key };
}

/** Build `s3://bucket/key` from a location. */
export function formatS3Uri(loc: S3Location): string {
  return `s3://${loc.bucket}/${loc.key}`;
}

/** Stream an S3 object to a local file path. Throws if the body is missing. */
export async function downloadS3ObjectToFile(
  client: S3Client,
  uri: string,
  destPath: string,
): Promise<void> {
  const { bucket, key } = parseS3Uri(uri);
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body as NodeJS.ReadableStream | undefined;
  if (!body) {
    throw new Error(`[s3Transport] s3 GetObject returned empty body for ${uri}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(body, createWriteStream(destPath));
}

/**
 * Upload a local file's contents to an S3 URI using a streaming
 * `PutObjectCommand`. PutObject's 5 GB cap comfortably exceeds the
 * distributed pipeline's 2 GB planDir limit and the typical
 * chunk size (≤ 200 MB), so a single PUT works for every artifact this
 * adapter handles.
 */
export async function uploadFileToS3(
  client: S3Client,
  localPath: string,
  uri: string,
  contentType?: string,
): Promise<void> {
  if (!existsSync(localPath)) {
    throw new Error(`[s3Transport] upload source missing: ${localPath}`);
  }
  const { bucket, key } = parseS3Uri(uri);
  const size = statSync(localPath).size;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: contentType,
      ContentLength: size,
    }),
  );
}

/**
 * Pack a directory into a `.tar.gz` at `destTarball` using the system `tar`
 * binary. Lambda's Amazon Linux runtime ships GNU tar; we use gzip for
 * round-trip compatibility with the local docker-based RIE smoke tests.
 */
export async function tarDirectory(sourceDir: string, destTarball: string): Promise<void> {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`[s3Transport] tar source must be an existing directory: ${sourceDir}`);
  }
  mkdirSync(dirname(destTarball), { recursive: true });
  await runProcess("tar", ["-czf", destTarball, "-C", sourceDir, "."]);
}

/**
 * Extract a `.tar.gz` produced by {@link tarDirectory} into `destDir`. The
 * directory is created (or cleared) before extraction so a retried invocation
 * doesn't observe stale files from a prior run on the same warm container.
 */
export async function untarDirectory(tarballPath: string, destDir: string): Promise<void> {
  if (!existsSync(tarballPath)) {
    throw new Error(`[s3Transport] tarball missing: ${tarballPath}`);
  }
  // Wipe target so the warm container's prior planDir doesn't bleed into
  // the new invocation. Lambda re-uses /tmp across invocations on the same
  // container.
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });
  await runProcess("tar", ["-xzf", tarballPath, "-C", destDir]);
}

/** List all regular files under a directory, sorted, returned as absolute paths. */
export function listFilesInDirectory(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  walk(dir);
  return out;
}

/** spawn(2)-style child process runner that resolves on exit 0, rejects otherwise. */
async function runProcess(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `[s3Transport] ${cmd} ${args.join(" ")} exited with code ${code}: ${Buffer.concat(
              stderr,
            ).toString("utf-8")}`,
          ),
        );
      }
    });
  });
}
