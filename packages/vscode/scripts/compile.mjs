import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'out')
fs.mkdirSync(outDir, { recursive: true })

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/extension.js'],
  bundle: true,
  outfile: path.join(outDir, 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
})

fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))
console.log('compiled', path.join(outDir, 'extension.js'))
