#!/usr/bin/env tsx
/**
 * Build the AWS Lambda deployment ZIP.
 *
 * Pack layout (paths inside the ZIP are relative to Lambda's
 * `/var/task/`):
 *
 *   handler.mjs                — bundled entry, set as Lambda's Handler
 *   handler.mjs.map            — sourcemap (debugging aid; small)
 *   bin/ffmpeg                 — ffmpeg-static binary
 *   bin/chrome-headless-shell  — fallback Chrome (only when CHROME_SOURCE=shell)
 *   node_modules/@sparticuz/chromium/
 *                              — primary Chrome (lives under node_modules so
 *                                runtime `import("@sparticuz/chromium")`
 *                                resolves; the package's own tarball stays
 *                                inside).
 *
 * The handler bundle (esbuild) externalises modules whose binary assets
 * must be present at runtime — `@sparticuz/chromium` for its bin tarball,
 * `puppeteer-core` because Lambda runtime resolves it via Node module
 * resolution from `node_modules/`. Everything else is inlined for cold
 * start speed.
 *
 * Run:
 *   bun run --cwd packages/aws-lambda build:zip
 *   bun run --cwd packages/aws-lambda build:zip -- --source=chrome-headless-shell
 *
 * Outputs the resolved ZIP path + size to stdout and writes a sidecar
 * JSON (`dist/handler.zip.manifest.json`) describing the contents.
 */

import { execSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const monorepoRoot = resolve(packageRoot, "../..");
const distDir = join(packageRoot, "dist");

interface BuildOptions {
  source: "sparticuz" | "chrome-headless-shell";
  /** Hard upper bound on the unzipped bundle size in bytes (Lambda limit is 250 MB). */
  maxUnzippedBytes: number;
  /** Hard upper bound on the ZIP file size in bytes. */
  maxZippedBytes: number;
}

const DEFAULT_OPTIONS: BuildOptions = {
  source: "sparticuz",
  // Lambda's hard ceiling for ZIP-deployed functions is 250 MB unzipped.
  // We gate at 240 MiB to keep room for the Chrome tarball decompression
  // that happens at cold start.
  maxUnzippedBytes: 240 * 1024 * 1024,
  // Lambda's only zipped-size cap is for direct console/CLI uploads (50 MB);
  // S3-deployed functions are bounded by the unzipped ceiling. We gate at
  // 150 MiB to flag a sudden bundle-size regression without false-failing
  // on the natural ~100 MiB sparticuz + ffmpeg payload.
  maxZippedBytes: 150 * 1024 * 1024,
};

function parseArgs(argv: string[]): BuildOptions {
  const opts = { ...DEFAULT_OPTIONS };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--source=")) {
      const v = arg.slice("--source=".length);
      if (v !== "sparticuz" && v !== "chrome-headless-shell") {
        throw new Error(`--source must be 'sparticuz' or 'chrome-headless-shell' (got ${v})`);
      }
      opts.source = v;
    } else if (arg.startsWith("--max-unzipped=")) {
      opts.maxUnzippedBytes = Number.parseInt(arg.slice("--max-unzipped=".length), 10);
    } else if (arg.startsWith("--max-zipped=")) {
      opts.maxZippedBytes = Number.parseInt(arg.slice("--max-zipped=".length), 10);
    } else if (arg === "--help") {
      console.log(
        "Usage: tsx build-zip.ts [--source=sparticuz|chrome-headless-shell]\n" +
          "                       [--max-unzipped=<bytes>] [--max-zipped=<bytes>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const start = Date.now();

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const stagingDir = join(distDir, "staging");
  mkdirSync(stagingDir, { recursive: true });

  console.log(`[build-zip] source=${opts.source}`);

  // 1. Bundle the handler.
  await bundleHandler(stagingDir);

  // 2. Stage runtime modules (puppeteer-core + @sparticuz/chromium or the
  //    fallback chrome-headless-shell tar).
  stageRuntimeModules(stagingDir, opts.source);

  // 3. Stage the ffmpeg binary.
  stageFfmpeg(stagingDir);

  // 4. If we're on the chrome-headless-shell fallback, stage that binary.
  if (opts.source === "chrome-headless-shell") {
    stageChromeHeadlessShell(stagingDir);
  }

  // 5. Compute the unzipped size BEFORE zipping so we fail loud when over budget.
  const unzippedBytes = directorySizeBytes(stagingDir);
  console.log(`[build-zip] unzipped staging size: ${formatBytes(unzippedBytes)}`);
  if (unzippedBytes > opts.maxUnzippedBytes) {
    throw new Error(
      `[build-zip] unzipped bundle ${formatBytes(unzippedBytes)} exceeds limit ${formatBytes(
        opts.maxUnzippedBytes,
      )} (Lambda ZIP ceiling: 250 MB unzipped). ` +
        `Switch --source to the lighter option, or move Chrome to a Lambda Layer.`,
    );
  }

  // 6. Build the ZIP.
  const zipPath = join(distDir, "handler.zip");
  zipDirectory(stagingDir, zipPath);
  const zippedBytes = statSync(zipPath).size;
  console.log(`[build-zip] zip size: ${formatBytes(zippedBytes)} → ${zipPath}`);
  if (zippedBytes > opts.maxZippedBytes) {
    throw new Error(
      `[build-zip] zip ${formatBytes(zippedBytes)} exceeds ZIP size limit ${formatBytes(
        opts.maxZippedBytes,
      )}.`,
    );
  }

  // 7. Sidecar manifest.
  const manifest = {
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    source: opts.source,
    unzippedBytes,
    zippedBytes,
    maxUnzippedBytes: opts.maxUnzippedBytes,
    maxZippedBytes: opts.maxZippedBytes,
  };
  writeFileSync(join(distDir, "handler.zip.manifest.json"), JSON.stringify(manifest, null, 2));

  // 8. Cleanup staging.
  rmSync(stagingDir, { recursive: true, force: true });
  console.log(`[build-zip] done in ${Date.now() - start}ms`);
}

async function bundleHandler(stagingDir: string): Promise<void> {
  const entry = join(packageRoot, "src/handler.ts");
  const outfile = join(stagingDir, "handler.mjs");

  const workspaceAliasPlugin: esbuild.Plugin = {
    name: "workspace-alias",
    setup(build) {
      build.onResolve({ filter: /^@hyperframes\/producer\/distributed$/ }, () => ({
        path: resolve(monorepoRoot, "packages/producer/src/distributed.ts"),
      }));
      build.onResolve({ filter: /^@hyperframes\/producer$/ }, () => ({
        path: resolve(monorepoRoot, "packages/producer/src/index.ts"),
      }));
      build.onResolve({ filter: /^@hyperframes\/engine$/ }, () => ({
        path: resolve(monorepoRoot, "packages/engine/src/index.ts"),
      }));
      build.onResolve({ filter: /^@hyperframes\/engine\/alpha-blit$/ }, () => ({
        path: resolve(monorepoRoot, "packages/engine/src/utils/alphaBlit.ts"),
      }));
      build.onResolve({ filter: /^@hyperframes\/engine\/shader-transitions$/ }, () => ({
        path: resolve(monorepoRoot, "packages/engine/src/utils/shaderTransitions.ts"),
      }));
      build.onResolve({ filter: /^@hyperframes\/core$/ }, () => ({
        path: resolve(monorepoRoot, "packages/core/src/index.ts"),
      }));
      build.onResolve({ filter: /^@hyperframes\/core\/lint$/ }, () => ({
        path: resolve(monorepoRoot, "packages/core/src/lint/index.ts"),
      }));
    },
  };

  await esbuild.build({
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // Externalise binary-shipped modules so node module resolution picks
    // them up at runtime. esbuild would otherwise try to inline their
    // postinstall-extracted binaries, which it cannot do.
    external: [
      "@sparticuz/chromium",
      "puppeteer-core",
      "puppeteer",
      // AWS SDK v3 is pre-installed in the Lambda Node 22 runtime; mark
      // external so we don't double-bundle 3+ MB of SDK.
      "@aws-sdk/client-s3",
    ],
    plugins: [workspaceAliasPlugin],
    minify: false,
    sourcemap: true,
    entryPoints: [entry],
    outfile,
    // Lambda's Node 22 runtime treats `.mjs` as ESM.
    banner: { js: "// hyperframes-aws-lambda handler bundle\n" },
  });
  console.log(`[build-zip] bundled handler → ${outfile}`);
}

function stageRuntimeModules(stagingDir: string, source: BuildOptions["source"]): void {
  const targetNodeModules = join(stagingDir, "node_modules");
  mkdirSync(targetNodeModules, { recursive: true });

  // puppeteer-core is required regardless of Chrome source.
  copyNodeModule("puppeteer-core", targetNodeModules);
  // AWS SDK comes from the Lambda runtime; no need to bundle.
  if (source === "sparticuz") {
    copyNodeModule("@sparticuz/chromium", targetNodeModules);
  }
}

function copyNodeModule(moduleName: string, targetNodeModules: string): void {
  const sourcePath = resolveModuleDir(moduleName);
  const destPath = join(targetNodeModules, moduleName);
  mkdirSync(dirname(destPath), { recursive: true });
  cpSync(sourcePath, destPath, { recursive: true, dereference: true });
}

function resolveModuleDir(moduleName: string): string {
  // Walk up from packageRoot to find a matching node_modules entry.
  let dir = packageRoot;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "node_modules", moduleName);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    `[build-zip] could not resolve ${moduleName} from ${packageRoot} — run 'bun install' first.`,
  );
}

function stageFfmpeg(stagingDir: string): void {
  const ffmpegModule = resolveModuleDir("ffmpeg-static");
  // `ffmpeg-static` exposes the binary at <module>/ffmpeg (or <module>/ffmpeg.exe).
  const binaryPath = join(ffmpegModule, "ffmpeg");
  if (!existsSync(binaryPath)) {
    throw new Error(
      `[build-zip] ffmpeg-static binary missing at ${binaryPath}. Did postinstall run?`,
    );
  }
  const binDir = join(stagingDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, "ffmpeg");
  cpSync(binaryPath, dest);
  chmodSync(dest, 0o755);
  console.log(`[build-zip] staged ffmpeg → bin/ffmpeg`);
}

function stageChromeHeadlessShell(stagingDir: string): void {
  // The fallback path bundles the same chrome-headless-shell binary the
  // K8s deploy uses. The binary is fetched via `@puppeteer/browsers` on
  // first build into the host's `~/.cache/puppeteer/`; the build script
  // re-uses that cache rather than redownloading.
  const home = process.env.HOME ?? "/root";
  const baseDir = join(home, ".cache", "puppeteer", "chrome-headless-shell");
  if (!existsSync(baseDir)) {
    throw new Error(
      `[build-zip] chrome-headless-shell cache missing at ${baseDir}. Run\n` +
        `  npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path ${home}/.cache/puppeteer\n` +
        `before --source=chrome-headless-shell.`,
    );
  }
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const versions = readdirSync(baseDir).sort().reverse();
  for (const v of versions) {
    const candidate = join(baseDir, v, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(candidate)) {
      const dest = join(stagingDir, "bin", "chrome-headless-shell");
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(candidate, dest);
      chmodSync(dest, 0o755);
      console.log(`[build-zip] staged chrome-headless-shell (${v}) → bin/chrome-headless-shell`);
      return;
    }
  }
  throw new Error(`[build-zip] no linux64 chrome-headless-shell binary found under ${baseDir}.`);
}

function zipDirectory(sourceDir: string, zipPath: string): void {
  const result = spawnSync("zip", ["-rq", zipPath, "."], { cwd: sourceDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`[build-zip] zip exited with status ${result.status}`);
  }
}

function directorySizeBytes(dir: string): number {
  // `du -sb` returns "<bytes>\t<path>". macOS coreutils doesn't ship `-b` —
  // build-zip is CI-side anyway, where Linux coreutils is present.
  try {
    const stdout = execSync(`du -sb ${JSON.stringify(dir)}`, { encoding: "utf-8" });
    return Number.parseInt(stdout.split(/\s+/)[0] ?? "0", 10);
  } catch {
    // Walk manually as a fallback.
    return walkSize(dir);
  }
}

function walkSize(dir: string): number {
  const { readdirSync, statSync: stat } = require("node:fs") as typeof import("node:fs");
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += walkSize(full);
    else if (entry.isFile()) total += stat(full).size;
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

void main().catch((err) => {
  console.error("[build-zip] failed:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
