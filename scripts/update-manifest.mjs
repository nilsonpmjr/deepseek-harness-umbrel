#!/usr/bin/env node
/**
 * Deterministically update Docker and Umbrel manifest files for a newly published
 * multi-arch image digest.
 *
 * Usage:
 *   node scripts/update-manifest.mjs \
 *     --dsh-version 0.2.3 \
 *     --image-tag 0.2.3 \
 *     --digest sha256:... \
 *     [--release-notes "..."]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`Missing value for ${key}`)
    }
    out[key.slice(2)] = val
    i += 1
  }
  return out
}

function replaceOrThrow(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Pattern not found for ${label}`)
  }
  return content.replace(pattern, replacement)
}

const args = parseArgs(process.argv.slice(2))
const dshVersion = args['dsh-version']
const imageTag = args['image-tag'] || dshVersion
const digest = args.digest
const imageRepo = args['image-repo'] || 'ghcr.io/nilsonpmjr/deepseek-harness-umbrel'
const releaseNotes = args['release-notes']
  || `Updated upstream DeepSeek Harness (@deepseek-ai/dsh) to ${dshVersion}.`

if (!dshVersion || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(dshVersion)) {
  throw new Error(`Invalid --dsh-version: ${dshVersion}`)
}
if (!imageTag || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(imageTag)) {
  throw new Error(`Invalid --image-tag: ${imageTag}`)
}
if (!digest || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
  throw new Error(`Invalid --digest: ${digest}`)
}

const root = resolve(process.cwd())
const dockerfilePath = resolve(root, 'docker/Dockerfile')
const composePath = resolve(root, 'deepseek-harness/docker-compose.yml')
const manifestPath = resolve(root, 'deepseek-harness/umbrel-app.yml')

const dockerfile = readFileSync(dockerfilePath, 'utf8')
const nextDockerfile = replaceOrThrow(
  dockerfile,
  /^ARG DSH_VERSION=.+$/mu,
  `ARG DSH_VERSION=${dshVersion}`,
  'docker/Dockerfile ARG DSH_VERSION',
)
writeFileSync(dockerfilePath, nextDockerfile)

const compose = readFileSync(composePath, 'utf8')
const nextCompose = replaceOrThrow(
  compose,
  /^(\s*image:\s*)\S+$/mu,
  `$1${imageRepo}:${imageTag}@${digest}`,
  'deepseek-harness/docker-compose.yml image',
)
writeFileSync(composePath, nextCompose)

const manifest = readFileSync(manifestPath, 'utf8')
let nextManifest = replaceOrThrow(
  manifest,
  /^version:\s*"[^"]+"$/mu,
  `version: "${imageTag}"`,
  'deepseek-harness/umbrel-app.yml version',
)
const formattedNotes = releaseNotes
  .split(/\r?\n/u)
  .map((line) => (line.trim() === '' ? '' : `  ${line}`))
  .join('\n')
nextManifest = replaceOrThrow(
  nextManifest,
  /^releaseNotes:[\s\S]*?(?=^developer:)/mu,
  `releaseNotes: >-\n${formattedNotes}\n`,
  'deepseek-harness/umbrel-app.yml releaseNotes',
)
writeFileSync(manifestPath, nextManifest)

console.log(`Updated manifests to @deepseek-ai/dsh@${dshVersion} (${imageRepo}:${imageTag}@${digest})`)
