// pipeline/knowledge/consumers/volatility-manifest-loader.ts
//
// Loads a VolatilityMapManifest for the planner. Resolution order:
//   1. FORGE_VOLATILITY_MANIFEST_PATH  (local file, manual/dev runs)
//   2. FORGE_VOLATILITY_BUCKET + FORGE_VOLATILITY_KEY  (S3, prod)
//   3. neither → null
//
// Never throws. Any failure (missing file, bad JSON, schema
// mismatch, S3 denied) logs once and returns null so the planner
// keeps running without a volatility block.
//
// Transports are injectable. Phorge ships filesystem only; callers
// that want S3 (or any other store) inject `readS3` themselves to
// keep phorge dep-free.

import { readFile } from 'node:fs/promises'
import {
  VolatilityMapManifest,
  type VolatilityMapManifest as VolatilityMapManifestT,
} from '../commit-mining'

export type VolatilityLoaderEnv = {
  FORGE_VOLATILITY_MANIFEST_PATH?: string
  FORGE_VOLATILITY_BUCKET?: string
  FORGE_VOLATILITY_KEY?: string
  [key: string]: string | undefined
}

export type VolatilityLoaderDeps = {
  env?: VolatilityLoaderEnv
  readLocal?: (path: string) => Promise<string>
  readS3?: (bucket: string, key: string) => Promise<string>
  logger?: (msg: string, err?: unknown) => void
}

const defaultLogger: NonNullable<VolatilityLoaderDeps['logger']> = (msg, err) => {
  if (err !== undefined) console.warn(`[volatility-loader] ${msg}`, err)
  else console.warn(`[volatility-loader] ${msg}`)
}

async function defaultReadLocal(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

function noS3Configured(): never {
  throw new Error(
    'S3 transport not configured. Inject `deps.readS3` if you need S3-backed manifests.',
  )
}

export async function loadVolatilityManifest(
  deps: VolatilityLoaderDeps = {},
): Promise<VolatilityMapManifestT | null> {
  const env = deps.env ?? (process.env as VolatilityLoaderEnv)
  const log = deps.logger ?? defaultLogger

  const localPath = env.FORGE_VOLATILITY_MANIFEST_PATH
  if (localPath && localPath.length > 0) {
    return readAndParse(
      () => (deps.readLocal ?? defaultReadLocal)(localPath),
      `local path ${localPath}`,
      log,
    )
  }

  const bucket = env.FORGE_VOLATILITY_BUCKET
  const key = env.FORGE_VOLATILITY_KEY
  if (bucket && key) {
    return readAndParse(
      () => (deps.readS3 ?? noS3Configured)(bucket, key),
      `s3://${bucket}/${key}`,
      log,
    )
  }

  return null
}

async function readAndParse(
  read: () => Promise<string>,
  source: string,
  log: NonNullable<VolatilityLoaderDeps['logger']>,
): Promise<VolatilityMapManifestT | null> {
  let raw: string
  try {
    raw = await read()
  } catch (err) {
    log(`failed to read manifest from ${source}`, err)
    return null
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    log(`manifest at ${source} is not valid JSON`, err)
    return null
  }

  const parsed = VolatilityMapManifest.safeParse(json)
  if (!parsed.success) {
    log(`manifest at ${source} failed schema validation`, parsed.error.issues)
    return null
  }
  return parsed.data
}
