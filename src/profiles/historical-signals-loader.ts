import { readFile } from 'node:fs/promises'
import {
  VolatilityMapManifest,
  CoChangeMatrixManifest,
  RevertChainsManifest,
  type VolatilityMapManifest as VolatilityMapManifestT,
  type CoChangeMatrixManifest as CoChangeMatrixManifestT,
  type RevertChainsManifest as RevertChainsManifestT,
} from '../commit-mining'
import type { ZodType } from 'zod'

export type HistoricalSignalsLoaderEnv = Record<string, string | undefined>

export type HistoricalSignalsLoaderDeps = {
  env?: HistoricalSignalsLoaderEnv
  readLocal?: (path: string) => Promise<string>
  readS3?: (bucket: string, key: string) => Promise<string>
  logger?: (msg: string, err?: unknown) => void
}

export type HistoricalSignalsBundle = {
  volatility: VolatilityMapManifestT | null
  coChange: CoChangeMatrixManifestT | null
  revertChains: RevertChainsManifestT | null
}

const defaultLogger: NonNullable<HistoricalSignalsLoaderDeps['logger']> = (msg, err) => {
  if (err !== undefined) console.warn(`[historical-signals-loader] ${msg}`, err)
  else console.warn(`[historical-signals-loader] ${msg}`)
}

async function defaultReadLocal(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

function noS3Configured(): never {
  throw new Error(
    'S3 transport not configured. Inject `deps.readS3` if you need S3-backed manifests.',
  )
}

type ManifestSpec<T> = {
  name: string
  localPathEnv: string
  bucketEnv: string
  keyEnv: string
  schema: ZodType<T>
}

const VOLATILITY_SPEC: ManifestSpec<VolatilityMapManifestT> = {
  name: 'volatility',
  localPathEnv: 'FORGE_VOLATILITY_MANIFEST_PATH',
  bucketEnv: 'FORGE_VOLATILITY_BUCKET',
  keyEnv: 'FORGE_VOLATILITY_KEY',
  schema: VolatilityMapManifest,
}

const COCHANGE_SPEC: ManifestSpec<CoChangeMatrixManifestT> = {
  name: 'co-change',
  localPathEnv: 'FORGE_COCHANGE_MANIFEST_PATH',
  bucketEnv: 'FORGE_COCHANGE_BUCKET',
  keyEnv: 'FORGE_COCHANGE_KEY',
  schema: CoChangeMatrixManifest,
}

const REVERT_CHAINS_SPEC: ManifestSpec<RevertChainsManifestT> = {
  name: 'revert-chains',
  localPathEnv: 'FORGE_REVERT_CHAINS_MANIFEST_PATH',
  bucketEnv: 'FORGE_REVERT_CHAINS_BUCKET',
  keyEnv: 'FORGE_REVERT_CHAINS_KEY',
  schema: RevertChainsManifest,
}

async function loadOne<T>(
  spec: ManifestSpec<T>,
  env: HistoricalSignalsLoaderEnv,
  readLocal: (path: string) => Promise<string>,
  readS3: (bucket: string, key: string) => Promise<string>,
  log: NonNullable<HistoricalSignalsLoaderDeps['logger']>,
): Promise<T | null> {
  const localPath = env[spec.localPathEnv]
  if (localPath && localPath.length > 0) {
    return readAndParse(spec, () => readLocal(localPath), `local ${localPath}`, log)
  }
  const bucket = env[spec.bucketEnv]
  const key = env[spec.keyEnv]
  if (bucket && key) {
    return readAndParse(spec, () => readS3(bucket, key), `s3://${bucket}/${key}`, log)
  }
  return null
}

async function readAndParse<T>(
  spec: ManifestSpec<T>,
  read: () => Promise<string>,
  source: string,
  log: NonNullable<HistoricalSignalsLoaderDeps['logger']>,
): Promise<T | null> {
  let raw: string
  try {
    raw = await read()
  } catch (err) {
    log(`failed to read ${spec.name} manifest from ${source}`, err)
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    log(`${spec.name} manifest at ${source} is not valid JSON`, err)
    return null
  }
  const parsed = spec.schema.safeParse(json)
  if (!parsed.success) {
    log(`${spec.name} manifest at ${source} failed schema validation`, parsed.error.issues)
    return null
  }
  return parsed.data
}

export async function loadHistoricalSignals(
  deps: HistoricalSignalsLoaderDeps = {},
): Promise<HistoricalSignalsBundle> {
  const env = deps.env ?? (process.env as HistoricalSignalsLoaderEnv)
  const log = deps.logger ?? defaultLogger
  const readLocal = deps.readLocal ?? defaultReadLocal
  const readS3 = deps.readS3 ?? noS3Configured

  const [volatility, coChange, revertChains] = await Promise.all([
    loadOne(VOLATILITY_SPEC, env, readLocal, readS3, log),
    loadOne(COCHANGE_SPEC, env, readLocal, readS3, log),
    loadOne(REVERT_CHAINS_SPEC, env, readLocal, readS3, log),
  ])

  return { volatility, coChange, revertChains }
}
