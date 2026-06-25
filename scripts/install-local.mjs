#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '')
const source = join(root, 'pr-watch.ts')
const home = process.env.HOME

if (!home) throw new Error('HOME is not set')
if (!existsSync(source)) throw new Error(`Missing source extension: ${source}`)

const destinations = [join(home, '.omp/agent/extensions/pr-watch.ts')]
const overlayRoot = join(home, '.config/orca/omp-agent-overlays')

if (existsSync(overlayRoot)) {
  for (const entry of readdirSync(overlayRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const overlayExtension = join(overlayRoot, entry.name, 'extensions/pr-watch.ts')
    if (existsSync(overlayExtension)) destinations.push(overlayExtension)
  }
}

for (const destination of destinations) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  console.log(`installed ${destination}`)
}
