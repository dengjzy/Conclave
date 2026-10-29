import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

const directory = fileURLToPath(new URL('../', import.meta.url))
await build({
  entryPoints: [path.join(directory, 'src/index.ts')], outfile: path.join(directory, 'dist/index.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['zod']
})
const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')))
execFileSync(process.execPath, [compiler, '-p', path.join(directory, 'tsconfig.build.json')], { stdio: 'inherit' })
// Declarations are generated from the canonical protocol, never copied by hand.
const declarations = path.join(directory, 'dist/types')
for (const file of await readdir(declarations, { recursive: true })) {
  if (!file.endsWith('.d.ts')) continue
  const name = path.join(declarations, file)
  const text = await readFile(name, 'utf8')
  await writeFile(name, text.replace(/from (['"])(\.[^'"]+)\1/g, (match, quote, specifier) => {
    return path.extname(specifier) ? match : `from ${quote}${specifier}.js${quote}`
  }))
}
