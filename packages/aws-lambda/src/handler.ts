/**
 * AWS Lambda handler for HyperFrames distributed rendering.
 *
 * One Lambda function, three roles. Step Functions dispatches by setting
 * `event.Action`; the handler unwraps Map-state envelopes, primes the
 * Lambda environment (Chrome path, ffmpeg path, tmpdir), and forwards to
 * the matching OSS primitive from `@hyperframes/producer/distributed`.
 *
 * Everything heavy — capture, encode, audio mix — happens inside the OSS
 * primitives. The handler is thin glue: parse event → S3 download → call
 * primitive → S3 upload → return small JSON result.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import {
  assemble,
  type AssembleResult,
  type ChunkResult,
  type DistributedRenderConfig,
  plan,
  type PlanResult,
  renderChunk,
} from "@hyperframes/producer/distributed";
import { resolveChromeExecutablePath } from "./chromium.js";
import type {
  AssembleEvent,
  AssembleLambdaResult,
  LambdaAction,
  LambdaEvent,
  LambdaResult,
  PlanEvent,
  PlanLambdaResult,
  RenderChunkEvent,
  RenderChunkLambdaResult,
} from "./events.js";
import {
  downloadS3ObjectToFile,
  listFilesInDirectory,
  parseS3Uri,
  tarDirectory,
  untarDirectory,
  uploadFileToS3,
} from "./s3Transport.js";

/**
 * Lazily-constructed S3 client. Cached at module scope so warm Lambda
 * containers reuse the underlying HTTP keep-alive pool across invocations.
 */
let cachedS3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (cachedS3Client) return cachedS3Client;
  cachedS3Client = new S3Client({});
  return cachedS3Client;
}

/** Test-only seam: inject a fake S3 client. */
export function _setS3ClientForTests(client: S3Client | null): void {
  cachedS3Client = client;
}

/**
 * Optional injection points used by the handler's unit tests. Production
 * callers leave these unset; the real OSS primitives are used.
 */
export interface HandlerDeps {
  s3?: S3Client;
  primitives?: {
    plan: typeof plan;
    renderChunk: typeof renderChunk;
    assemble: typeof assemble;
  };
  /** Override the per-invocation `/tmp` workdir root (defaults to Lambda's `/tmp`). */
  tmpRoot?: string;
  /** Skip Chrome resolution (used by handler dispatch tests that mock renderChunk). */
  skipChromeResolution?: boolean;
}

/**
 * Lambda entry. Step Functions sometimes wraps the event in
 * `{ Payload: ... }` or `{ Input: ... }` depending on the state machine
 * shape; unwrap until we hit a discriminated event.
 */
export async function handler(event: LambdaEvent, deps?: HandlerDeps): Promise<LambdaResult> {
  const unwrapped = unwrapEvent(event);
  primeRuntimeEnv();
  switch (unwrapped.Action) {
    case "plan":
      return handlePlan(unwrapped, deps);
    case "renderChunk":
      return handleRenderChunk(unwrapped, deps);
    case "assemble":
      return handleAssemble(unwrapped, deps);
    default:
      throw new Error(
        `[handler] unknown Action: ${JSON.stringify(
          (unwrapped as { Action?: string }).Action,
        )}. Expected one of "plan", "renderChunk", "assemble".`,
      );
  }
}

/**
 * Walk through Step Functions' Map-state and Task-state envelopes until
 * the discriminated event is found.
 */
export function unwrapEvent(event: LambdaEvent): PlanEvent | RenderChunkEvent | AssembleEvent {
  let cursor: LambdaEvent = event;
  for (let i = 0; i < 4; i++) {
    if (cursor && typeof cursor === "object") {
      const obj = cursor as Record<string, unknown>;
      if (typeof obj.Action === "string" && isLambdaAction(obj.Action)) {
        return cursor as PlanEvent | RenderChunkEvent | AssembleEvent;
      }
      if ("Payload" in obj) {
        cursor = obj.Payload as LambdaEvent;
        continue;
      }
      if ("Input" in obj) {
        cursor = obj.Input as LambdaEvent;
        continue;
      }
    }
    break;
  }
  throw new Error(
    "[handler] event has no recognised Action; unwrapped 4 levels of Payload/Input without finding one.",
  );
}

function isLambdaAction(value: string): value is LambdaAction {
  return value === "plan" || value === "renderChunk" || value === "assemble";
}

/**
 * Lambda sets `TMPDIR` to `/tmp` already, but the bundled binaries (Chrome
 * + ffmpeg) live alongside the handler at `/var/task/bin/`. Add that to
 * PATH the first time the handler runs so spawn("ffmpeg", …) inside the
 * OSS primitives resolves to the bundled binary.
 */
let runtimeEnvPrimed = false;
function primeRuntimeEnv(): void {
  if (runtimeEnvPrimed) return;
  runtimeEnvPrimed = true;
  const taskRoot = process.env.LAMBDA_TASK_ROOT ?? "/var/task";
  const bin = join(taskRoot, "bin");
  if (existsSync(bin)) {
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  }
}

// ── Plan ────────────────────────────────────────────────────────────────────

async function handlePlan(event: PlanEvent, deps?: HandlerDeps): Promise<PlanLambdaResult> {
  const started = Date.now();
  const s3 = deps?.s3 ?? getS3Client();
  const primitive = deps?.primitives?.plan ?? plan;

  const work = mkdtempSync(join(deps?.tmpRoot ?? tmpdir(), "hf-lambda-plan-"));
  const projectZip = join(work, "project.zip");
  const projectDir = join(work, "project");
  const planDir = join(work, "plan");

  try {
    await downloadS3ObjectToFile(s3, event.ProjectS3Uri, projectZip);
    await extractProjectZip(projectZip, projectDir);

    const config: DistributedRenderConfig = {
      ...event.Config,
    };
    const result: PlanResult = await primitive(projectDir, config, planDir);

    // Upload the planDir as a single tarball. Step Functions cannot pass
    // a directory-shaped artifact between states; we serialize and rely on
    // the consumer (renderChunk / assemble) to untar.
    const planTar = join(work, "plan.tar.gz");
    await tarDirectory(planDir, planTar);
    const planTarUri = `${trimTrailingSlash(event.PlanOutputS3Prefix)}/plan.tar.gz`;
    await uploadFileToS3(s3, planTar, planTarUri, "application/gzip");

    // Audio is co-located alongside the plan so RenderChunk doesn't have
    // to pull the whole plan tarball when audio isn't relevant to the
    // chunk. Assemble downloads it separately.
    const audioPath = join(planDir, "audio.aac");
    let audioUri: string | null = null;
    if (existsSync(audioPath) && statSync(audioPath).size > 0) {
      audioUri = `${trimTrailingSlash(event.PlanOutputS3Prefix)}/audio.aac`;
      await uploadFileToS3(s3, audioPath, audioUri, "audio/aac");
    }

    return {
      Action: "plan",
      PlanS3Uri: planTarUri,
      PlanHash: result.planHash,
      ChunkCount: result.chunkCount,
      TotalFrames: result.totalFrames,
      Fps: result.fps,
      Width: result.width,
      Height: result.height,
      Format: result.format,
      HasAudio: audioUri !== null,
      AudioS3Uri: audioUri,
      FfmpegVersion: result.ffmpegVersion,
      ProducerVersion: result.producerVersion,
      DurationMs: Date.now() - started,
    };
  } finally {
    cleanupDir(work);
  }
}

// ── RenderChunk ─────────────────────────────────────────────────────────────

async function handleRenderChunk(
  event: RenderChunkEvent,
  deps?: HandlerDeps,
): Promise<RenderChunkLambdaResult> {
  const started = Date.now();
  const s3 = deps?.s3 ?? getS3Client();
  const primitive = deps?.primitives?.renderChunk ?? renderChunk;

  if (!deps?.skipChromeResolution) {
    const chromePath = await resolveChromeExecutablePath();
    // The OSS engine resolves Chrome via `PRODUCER_HEADLESS_SHELL_PATH`
    // first (see `browserManager.resolveHeadlessShellPath`); set it before
    // invoking the primitive so launch picks up the bundled binary.
    process.env.PRODUCER_HEADLESS_SHELL_PATH = chromePath;
  }

  const work = mkdtempSync(join(deps?.tmpRoot ?? tmpdir(), "hf-lambda-chunk-"));
  const planTar = join(work, "plan.tar.gz");
  const planDir = join(work, "plan");

  try {
    await downloadS3ObjectToFile(s3, event.PlanS3Uri, planTar);
    await untarDirectory(planTar, planDir);

    const chunkOutputBase = join(
      work,
      event.Format === "png-sequence"
        ? `chunk-${pad(event.ChunkIndex)}`
        : `chunk-${pad(event.ChunkIndex)}${formatExtension(event.Format)}`,
    );

    const result: ChunkResult = await primitive(planDir, event.ChunkIndex, chunkOutputBase);

    const chunkUri = await uploadChunkOutput(
      s3,
      result,
      event.ChunkOutputS3Prefix,
      event.ChunkIndex,
    );

    return {
      Action: "renderChunk",
      ChunkS3Uri: chunkUri,
      ChunkIndex: event.ChunkIndex,
      Sha256: result.sha256,
      FramesEncoded: result.framesEncoded,
      DurationMs: Date.now() - started,
    };
  } finally {
    cleanupDir(work);
  }
}

async function uploadChunkOutput(
  s3: S3Client,
  result: ChunkResult,
  prefix: string,
  chunkIndex: number,
): Promise<string> {
  const trimmed = trimTrailingSlash(prefix);
  if (result.outputKind === "file") {
    const ext = result.outputPath.slice(result.outputPath.lastIndexOf("."));
    const uri = `${trimmed}/chunks/${pad(chunkIndex)}${ext}`;
    await uploadFileToS3(s3, result.outputPath, uri);
    return uri;
  }
  // frame-dir: upload as a tarball so a single S3 object represents the chunk.
  // Assemble's png-sequence path expects a directory per chunk; it untars on
  // its end.
  const tarball = `${result.outputPath}.tar.gz`;
  await tarDirectory(result.outputPath, tarball);
  const uri = `${trimmed}/chunks/${pad(chunkIndex)}.tar.gz`;
  await uploadFileToS3(s3, tarball, uri, "application/gzip");
  return uri;
}

// ── Assemble ────────────────────────────────────────────────────────────────

async function handleAssemble(
  event: AssembleEvent,
  deps?: HandlerDeps,
): Promise<AssembleLambdaResult> {
  const started = Date.now();
  const s3 = deps?.s3 ?? getS3Client();
  const primitive = deps?.primitives?.assemble ?? assemble;

  const work = mkdtempSync(join(deps?.tmpRoot ?? tmpdir(), "hf-lambda-assemble-"));
  const planTar = join(work, "plan.tar.gz");
  const planDir = join(work, "plan");

  try {
    await downloadS3ObjectToFile(s3, event.PlanS3Uri, planTar);
    await untarDirectory(planTar, planDir);

    const chunkPaths = await downloadChunkObjects(s3, event.ChunkS3Uris, work, event.Format);

    let audioPath: string | null = null;
    if (event.AudioS3Uri) {
      audioPath = join(planDir, "audio.aac");
      await downloadS3ObjectToFile(s3, event.AudioS3Uri, audioPath);
    }

    const finalOutput =
      event.Format === "png-sequence"
        ? join(work, "output-frames")
        : join(work, `output${formatExtension(event.Format)}`);

    const result: AssembleResult = await primitive(planDir, chunkPaths, audioPath, finalOutput);

    if (event.Format === "png-sequence") {
      const tarball = `${finalOutput}.tar.gz`;
      await tarDirectory(finalOutput, tarball);
      await uploadFileToS3(s3, tarball, event.OutputS3Uri, "application/gzip");
    } else {
      await uploadFileToS3(s3, finalOutput, event.OutputS3Uri);
    }

    return {
      Action: "assemble",
      OutputS3Uri: event.OutputS3Uri,
      FramesEncoded: result.framesEncoded,
      FileSize: result.fileSize,
      DurationMs: Date.now() - started,
    };
  } finally {
    cleanupDir(work);
  }
}

async function downloadChunkObjects(
  s3: S3Client,
  uris: string[],
  workDir: string,
  format: "mp4" | "mov" | "png-sequence",
): Promise<string[]> {
  const chunksDir = join(workDir, "chunks");
  mkdirSync(chunksDir, { recursive: true });
  const local: string[] = [];
  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    if (!uri) {
      throw new Error(`[handler] chunk URI at index ${i} is empty`);
    }
    const { key } = parseS3Uri(uri);
    const localPath = join(chunksDir, basenameOf(key));
    await downloadS3ObjectToFile(s3, uri, localPath);
    if (format === "png-sequence") {
      const dirPath = join(chunksDir, `frames-${pad(i)}`);
      await untarDirectory(localPath, dirPath);
      local.push(dirPath);
    } else {
      local.push(localPath);
    }
  }
  return local;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function extractProjectZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  // Lambda's base image (Amazon Linux) ships `unzip` in /usr/bin; we invoke
  // it via spawn to avoid bundling a Node-native unzip implementation.
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("unzip", ["-q", "-o", zipPath, "-d", destDir], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`[handler] unzip ${zipPath} exited with code ${code}`)),
    );
  });
}

function pad(n: number): string {
  return n.toString().padStart(4, "0");
}

function trimTrailingSlash(prefix: string): string {
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

function formatExtension(format: "mp4" | "mov" | "png-sequence"): string {
  switch (format) {
    case "mp4":
      return ".mp4";
    case "mov":
      return ".mov";
    case "png-sequence":
      return "";
  }
}

function basenameOf(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

function cleanupDir(dir: string): void {
  try {
    // Lambda warm starts can reuse `/tmp` across invocations; clean up
    // aggressively so we don't leak a chunk-sized footprint between renders.
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — leak is preferable to crashing on success path.
  }
}

/** Exported for symmetry with other adapter packages. */
export { listFilesInDirectory };
