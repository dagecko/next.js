#!/usr/bin/env node
//
// Cache compiled Rust dependency artifacts (proc-macros, build scripts,
// rlibs, fingerprints) in the turbo remote cache.
//
// This caches everything sccache can't: proc-macro dylibs, build script
// outputs, and their cargo fingerprints. Keyed by Cargo.lock + toolchain +
// profile + target, so deps are only rebuilt when they actually change.
//
// Usage:
//   node scripts/rust-dep-cache.js --restore --target x86_64-pc-windows-msvc --profile release-with-assertions
//   node scripts/rust-dep-cache.js --save    --target x86_64-pc-windows-msvc --profile release-with-assertions

const { execSync } = require('child_process')
const { createHash } = require('crypto')
const path = require('path')
const fs = require('fs')
const os = require('os')
const cache = require('./turbo-cache')

const { parseArgs } = require('node:util')
const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    restore: { type: 'boolean', default: false },
    save: { type: 'boolean', default: false },
    target: { type: 'string', default: '' },
    profile: { type: 'string', default: 'release' },
  },
})

const REPO_ROOT = path.resolve(__dirname, '..')

// Files that determine the dependency build output
const CACHE_KEY_INPUTS = [
  path.join(REPO_ROOT, 'Cargo.lock'),
  path.join(REPO_ROOT, 'rust-toolchain.toml'),
  path.join(REPO_ROOT, '.cargo/config.toml'),
]

function computeCacheKey() {
  const hash = createHash('sha256')
  hash.update(`rust-dep-cache-v1\0`)
  hash.update(`target=${flags.target}\0`)
  hash.update(`profile=${flags.profile}\0`)
  hash.update(`os=${process.platform}\0`)
  hash.update(`arch=${process.arch}\0`)
  for (const file of CACHE_KEY_INPUTS) {
    if (fs.existsSync(file)) {
      hash.update(file + '\0')
      hash.update(fs.readFileSync(file))
    }
  }
  return hash.digest('hex')
}

// Directories within target/ to cache.
// These contain compiled deps, build script outputs, and cargo fingerprints.
function cacheDirs() {
  const targetDir = path.join(REPO_ROOT, 'target')
  const dirs = []

  // Host profile (build scripts, proc-macros)
  const hostProfile = path.join(targetDir, flags.profile)
  if (fs.existsSync(path.join(hostProfile, 'deps'))) {
    dirs.push(path.join(hostProfile, 'deps'))
    dirs.push(path.join(hostProfile, 'build'))
    dirs.push(path.join(hostProfile, '.fingerprint'))
  }

  // Target-specific profile (cross-compiled deps)
  if (flags.target) {
    const targetProfile = path.join(targetDir, flags.target, flags.profile)
    if (fs.existsSync(path.join(targetProfile, 'deps'))) {
      dirs.push(path.join(targetProfile, 'deps'))
      dirs.push(path.join(targetProfile, 'build'))
      dirs.push(path.join(targetProfile, '.fingerprint'))
    }
  }

  return dirs.filter((d) => fs.existsSync(d))
}

function tmpFile(name) {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), name)
}

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' })
}

async function restore() {
  const key = computeCacheKey()
  console.log(`Rust dep cache key: ${key}`)
  console.log(`  target: ${flags.target || '(host)'}`)
  console.log(`  profile: ${flags.profile}`)

  if (!process.env.TURBO_TOKEN) {
    console.log('No TURBO_TOKEN — skipping dep cache restore')
    return false
  }

  const hit = await cache.exists(key)
  if (!hit) {
    console.log('Dep cache MISS')
    return false
  }

  console.log('Dep cache HIT — downloading...')
  const tarFile = tmpFile('rust-dep-cache.tar.zst')
  const ok = await cache.getToFile(key, tarFile)
  if (!ok) {
    console.log('Download failed')
    return false
  }

  const size = fs.statSync(tarFile).size
  console.log(`Downloaded ${(size / 1024 / 1024).toFixed(0)} MB`)

  // Extract into repo root (paths in tar are relative to repo root)
  sh(`zstd -d -c "${tarFile}" | tar xf - -C "${REPO_ROOT}"`)
  fs.unlinkSync(tarFile)
  console.log('Dep cache restored')
  return true
}

async function save() {
  const key = computeCacheKey()
  console.log(`Rust dep cache key: ${key}`)

  if (!process.env.TURBO_TOKEN) {
    console.log('No TURBO_TOKEN — skipping dep cache save')
    return
  }

  // Check if already cached (avoid re-uploading)
  const exists = await cache.exists(key)
  if (exists) {
    console.log('Dep cache already exists — skipping save')
    return
  }

  const dirs = cacheDirs()
  if (dirs.length === 0) {
    console.log('No target dirs to cache')
    return
  }

  // Create tar with paths relative to repo root
  const tarFile = tmpFile('rust-dep-cache.tar.zst')
  const relativeDirs = dirs
    .map((d) => path.relative(REPO_ROOT, d))
    .join(' ')

  console.log(`Caching: ${relativeDirs}`)
  sh(`tar cf - -C "${REPO_ROOT}" ${relativeDirs} | zstd -3 -T0 -o "${tarFile}"`)

  const size = fs.statSync(tarFile).size
  console.log(`Compressed: ${(size / 1024 / 1024).toFixed(0)} MB — uploading...`)

  try {
    await cache.put(key, tarFile)
    console.log('Dep cache saved')
  } catch (e) {
    console.log(`WARNING: Failed to save dep cache: ${e.message}`)
  }

  fs.unlinkSync(tarFile)
}

async function main() {
  if (flags.restore) {
    await restore()
  } else if (flags.save) {
    await save()
  } else {
    console.error('Usage: --restore or --save (with --target and --profile)')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
