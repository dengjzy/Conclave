import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it('builds the missing DeepSeek runtime before starting core, then reuses it on the next start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conclave-launcher-runtime-'))
  try {
    for (const dir of ['bin', 'scripts', 'packages/web/dist', 'packages/core/src']) await mkdir(path.join(root, dir), { recursive: true })
    await copyFile(new URL('../../../bin/conclave.mjs', import.meta.url), path.join(root, 'bin/conclave.mjs'))
    await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'junction')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: 'test' }))
    await writeFile(path.join(root, 'packages/web/dist/index.html'), 'fixture')
    await writeFile(path.join(root, 'packages/core/src/main.ts'), "import { existsSync } from 'node:fs'; if (!existsSync('packages/dsh-runtime/dist/runtime.tgz')) process.exit(42); console.log('core-ready')")
    await writeFile(path.join(root, 'scripts/build-plugins.mjs'), `import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
if (existsSync('built')) throw new Error('runtime was rebuilt unnecessarily');
mkdirSync('packages/dsh-runtime/dist', {recursive:true}); writeFileSync('packages/dsh-runtime/dist/runtime.tgz','fixture-runtime'); writeFileSync('built','yes');`)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await execute(process.execPath, ['bin/conclave.mjs', 'start', '--no-daemon'], { cwd: root, env: { ...process.env, CONCLAVE_HOME: path.join(root, 'home') }, timeout: 15000 })
      expect(result.stdout).toContain('core-ready')
    }
    expect(await readFile(path.join(root, 'packages/dsh-runtime/dist/runtime.tgz'), 'utf8')).toBe('fixture-runtime')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
