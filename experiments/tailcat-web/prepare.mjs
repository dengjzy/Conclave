#!/usr/bin/env node
// Asset preparation for this Linux x64 experiment only. Requires curl and tar.
// Downloads are hash-pinned; this script never runs the downloaded executable.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const sourceCommit = 'e00cdde6ff787f801361ff85ed085775c775d4c5';
const pagesBuild = 'https://github.com/tailscale/tailcat/actions/runs/42052251989';
const archive = {
  file: 'tailcat_0.7.0_linux_amd64.tar.gz',
  url: 'https://github.com/tailscale/tailcat/releases/download/v0.7.0/tailcat_0.7.0_linux_amd64.tar.gz',
  sha256: '23c0b1887a5ec422f0d18a9c52b4f5357815febdaae738a1eb54036d10bd9ee6',
};
const binary = {
  file: 'cli/tailcat',
  sha256: '75da81231e01f2a52005f26f4eca6df4bce71cb694a42fa467a30e93c3d7a5b9',
};
// GitHub Pages URLs are mutable. Fail closed if their bytes change; do not
// silently pair a new browser build with this pinned CLI release.
const browserAssets = [
  {
    file: 'main.wasm.gz',
    url: 'https://tailscale.github.io/tailcat/main.wasm.gz',
    sha256: '91e59ba10ef0b4d6ffdab3bb992ffdfb9ed897539d375173a4f6853525e864e6',
  },
  {
    file: 'wasm_exec.js',
    url: 'https://tailscale.github.io/tailcat/wasm_exec.js',
    sha256: '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14',
  },
];
const wasm = {
  file: 'main.wasm',
  sha256: '8bb51933c965f0ef5fc9c9e06c096c1dad782caffc2e680af6c6c4cbf472bcff',
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function matches(path, expected) {
  try {
    return digest(await readFile(path)) === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function run(command, args, { collect = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', collect ? 'pipe' : 'inherit', 'inherit'] });
    const chunks = [];
    if (collect) child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) reject(new Error(`${command} failed (${signal ?? code})`));
      else resolveRun(collect ? Buffer.concat(chunks) : undefined);
    });
  });
}

async function download(asset, directory, temporary) {
  const destination = join(directory, asset.file);
  if (await matches(destination, asset.sha256)) {
    console.log(`Verified cached ${asset.file}`);
    return destination;
  }
  console.log(`Downloading ${asset.file}`);
  const partial = join(temporary, asset.file);
  await run('curl', [
    '--fail', '--location', '--silent', '--show-error',
    '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '20', '--max-time', '600', '--retry', '2',
    '--output', partial, asset.url,
  ]);
  const actual = digest(await readFile(partial));
  if (actual !== asset.sha256) {
    throw new Error(
      `${asset.file}: SHA-256 mismatch. Expected ${asset.sha256}, received ${actual}. ` +
      'The downloaded file was not installed. The official Pages build may have changed; ' +
      `use the verified assets from Pages source commit ${sourceCommit}, or rebuild and review a new pinned set.`,
    );
  }
  await rename(partial, destination);
  return destination;
}

async function main() {
  if (process.argv.length !== 3 || ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: node prepare.mjs <assets-directory>\nLinux x64 only; requires curl and tar.');
    if (process.argv.length !== 3) process.exitCode = 1;
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('This pinned experiment supports Linux x64 only; no assets were installed.');
  }
  const directory = resolve(process.argv[2]);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, '.prepare-'));
  try {
    await mkdir(join(directory, 'cli'), { recursive: true });
    const binaryPath = join(directory, binary.file);
    if (!(await matches(binaryPath, binary.sha256))) {
      const archivePath = await download(archive, directory, temporary);
      const executable = await run('tar', ['-xOf', archivePath, 'tailcat'], { collect: true });
      if (digest(executable) !== binary.sha256) throw new Error('Extracted tailcat executable failed SHA-256 verification.');
      const stagedBinary = join(temporary, 'tailcat');
      await writeFile(stagedBinary, executable, { mode: 0o755 });
      await rename(stagedBinary, binaryPath);
    } else {
      console.log('Verified cached tailcat');
    }
    await chmod(binaryPath, 0o755);
    for (const asset of browserAssets) await download(asset, directory, temporary);
    const wasmPath = join(directory, wasm.file);
    if (!(await matches(wasmPath, wasm.sha256))) {
      const bytes = gunzipSync(await readFile(join(directory, 'main.wasm.gz')), { maxOutputLength: 27_000_000 });
      if (digest(bytes) !== wasm.sha256) throw new Error('Decompressed main.wasm failed SHA-256 verification.');
      const stagedWasm = join(temporary, wasm.file);
      await writeFile(stagedWasm, bytes);
      await rename(stagedWasm, wasmPath);
    }
    await writeFile(join(directory, 'sources.json'), JSON.stringify({
      experiment: 'Conclave Tailcat browser prototype, Linux x64',
      cliVersion: 'v0.7.0',
      pagesSourceCommit: sourceCommit,
      pagesBuild,
      assets: [archive, { ...binary, derivedFrom: archive.file }, ...browserAssets, { ...wasm, derivedFrom: 'main.wasm.gz' }],
    }, null, 2) + '\n');
    console.log(`Verified assets ready in ${directory}. No downloaded executable was run.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Asset preparation failed: ${error.message}`);
  process.exitCode = 1;
});
