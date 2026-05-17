import assert from 'node:assert'
import fs, { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileExists, readIfExists, rmIfExists } from '@atproto/common'
import * as crypto from '@atproto/crypto'
import { ExportableKeypair, Keypair } from '@atproto/crypto'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { ActorStoreConfig, TursoActorStoreConfig } from '../config'
import { retrySqlite } from '../db'
import { DiskBlobStore } from '../disk-blobstore'
import { blobStoreLogger } from '../logger'
import { ActorStoreReader } from './actor-store-reader'
import { ActorStoreResources } from './actor-store-resources'
import { ActorStoreTransactor } from './actor-store-transactor'
import { ActorStoreWriter } from './actor-store-writer'
import { ActorDb, getDb, getMigrator } from './db'
import { TursoPlatformClient } from './turso-platform'

// Turso DB names must be lowercase alphanumeric + dashes, length-limited.
// The did's sha256 hex hash is safe; truncate to keep names short.
const TURSO_DID_HASH_LEN = 40

export class ActorStore {
  reservedKeyDir: string
  turso: TursoPlatformClient | null

  constructor(
    public cfg: ActorStoreConfig,
    public resources: ActorStoreResources,
  ) {
    this.reservedKeyDir = path.join(cfg.directory, 'reserved_keys')
    this.turso = cfg.turso ? new TursoPlatformClient(cfg.turso) : null
  }

  private get tursoCfg(): TursoActorStoreConfig | null {
    return this.cfg.turso
  }

  private dbNameFromHash(didHash: string): string {
    const cfg = this.tursoCfg
    if (!cfg) throw new Error('turso not configured')
    return `${cfg.dbNamePrefix}${didHash.slice(0, TURSO_DID_HASH_LEN)}`
  }

  async getLocation(did: string) {
    const didHash = await crypto.sha256Hex(did)
    const directory = path.join(this.cfg.directory, didHash.slice(0, 2), did)
    const dbLocation = path.join(directory, `store.sqlite`)
    const keyLocation = path.join(directory, `key`)
    const dbName = this.tursoCfg ? this.dbNameFromHash(didHash) : undefined
    return { directory, dbLocation, keyLocation, dbName }
  }

  async exists(did: string): Promise<boolean> {
    const location = await this.getLocation(did)
    if (this.turso && location.dbName) {
      return this.turso.databaseExists(location.dbName)
    }
    return await fileExists(location.dbLocation)
  }

  async keypair(did: string): Promise<Keypair> {
    if (this.turso) {
      const db = await this.openDb(did)
      try {
        return await keypairFromDb(db)
      } finally {
        db.close()
      }
    }
    return keypairFromDisk((await this.getLocation(did)).keyLocation)
  }

  async openDb(did: string): Promise<ActorDb> {
    const location = await this.getLocation(did)
    let db: ActorDb
    if (this.turso && location.dbName) {
      const url = this.turso.buildDatabaseUrl(location.dbName)
      db = getDb({
        location: location.dbLocation,
        disableWalAutoCheckpoint: this.cfg.disableWalAutoCheckpoint,
        turso: {
          url,
          authToken: this.tursoCfg?.databaseAuthToken,
        },
      })
    } else {
      const exists = await fileExists(location.dbLocation)
      if (!exists) {
        throw new InvalidRequestError('Repo not found', 'NotFound')
      }
      db = getDb({
        location: location.dbLocation,
        disableWalAutoCheckpoint: this.cfg.disableWalAutoCheckpoint,
      })
    }

    // run a simple select with retry logic to ensure the db is ready (not in wal recovery mode)
    try {
      await retrySqlite(() =>
        db.db.selectFrom('repo_root').selectAll().execute(),
      )
    } catch (err) {
      db.close()
      throw err
    }

    return db
  }

  async read<T>(did: string, fn: (fn: ActorStoreReader) => T | PromiseLike<T>) {
    const db = await this.openDb(did)
    try {
      const getKeypair = () => this.keypair(did)
      return await fn(new ActorStoreReader(did, db, this.resources, getKeypair))
    } finally {
      db.close()
    }
  }

  async transact<T>(
    did: string,
    fn: (fn: ActorStoreTransactor) => T | PromiseLike<T>,
  ) {
    const db = await this.openDb(did)
    try {
      const keypair = this.turso
        ? await keypairFromDb(db)
        : await keypairFromDisk((await this.getLocation(did)).keyLocation)
      return await db.transaction((dbTxn) => {
        return fn(new ActorStoreTransactor(did, dbTxn, keypair, this.resources))
      })
    } finally {
      db.close()
    }
  }

  async writeNoTransaction<T>(
    did: string,
    fn: (fn: ActorStoreWriter) => T | PromiseLike<T>,
  ) {
    const db = await this.openDb(did)
    try {
      const keypair = this.turso
        ? await keypairFromDb(db)
        : await keypairFromDisk((await this.getLocation(did)).keyLocation)
      return await fn(new ActorStoreWriter(did, db, keypair, this.resources))
    } finally {
      db.close()
    }
  }

  async create(did: string, keypair: ExportableKeypair) {
    const location = await this.getLocation(did)
    const { directory, dbLocation, keyLocation, dbName } = location
    // ensure subdir exists — did-op stays on disk even in turso mode
    await mkdir(directory, { recursive: true })

    if (this.turso && dbName) {
      const alreadyExists = await this.turso.databaseExists(dbName)
      if (alreadyExists) {
        throw new InvalidRequestError('Repo already exists', 'AlreadyExists')
      }
    } else {
      const exists = await fileExists(dbLocation)
      if (exists) {
        throw new InvalidRequestError('Repo already exists', 'AlreadyExists')
      }
    }

    const privKey = await keypair.export()
    const tursoMode = !!(this.turso && dbName)
    if (!tursoMode) {
      await fs.writeFile(keyLocation, privKey)
    }

    let db: ActorDb
    if (this.turso && dbName) {
      try {
        await this.turso.createDatabase(dbName)
        db = getDb({
          location: dbLocation,
          disableWalAutoCheckpoint: this.cfg.disableWalAutoCheckpoint,
          turso: {
            url: this.turso.buildDatabaseUrl(dbName),
            authToken: this.tursoCfg?.databaseAuthToken,
          },
        })
      } catch (err) {
        console.error(err)
        throw err
      }
    } else {
      db = getDb({
        location: dbLocation,
        disableWalAutoCheckpoint: this.cfg.disableWalAutoCheckpoint,
      })
    }
    try {
      await db.ensureWal()
      const migrator = getMigrator(db)
      await migrator.migrateToLatestOrThrow()
      if (tursoMode) {
        await db.db
          .insertInto('actor_key')
          .values({ id: 1, privKey })
          .execute()
      }
    } finally {
      db.close()
    }
  }

  async destroy(did: string) {
    const blobstore = this.resources.blobstore(did)
    if (blobstore instanceof DiskBlobStore) {
      await blobstore.deleteAll()
    } else {
      const cids = await this.read(did, async (store) =>
        store.repo.blob.getBlobCids(),
      )
      await blobstore.deleteMany(cids).catch((err) => {
        blobStoreLogger.error('Failed to delete blobs', { did, cids, err })
      })
    }

    const { directory, dbName } = await this.getLocation(did)
    if (this.turso && dbName) {
      await this.turso.deleteDatabase(dbName).catch((err) => {
        blobStoreLogger.error('Failed to delete turso db', { did, dbName, err })
      })
    }
    await rmIfExists(directory, true)
  }

  async reserveKeypair(did?: string): Promise<string> {
    let keyLoc: string | undefined
    if (did) {
      assertSafePathPart(did)
      keyLoc = path.join(this.reservedKeyDir, did)
      const maybeKey = await loadKey(keyLoc)
      if (maybeKey) {
        return maybeKey.did()
      }
    }
    const keypair = await crypto.Secp256k1Keypair.create({ exportable: true })
    const keyDid = keypair.did()
    keyLoc = keyLoc ?? path.join(this.reservedKeyDir, keyDid)
    await mkdir(this.reservedKeyDir, { recursive: true })
    await fs.writeFile(keyLoc, await keypair.export())
    return keyDid
  }

  async getReservedKeypair(
    signingKeyOrDid: string,
  ): Promise<ExportableKeypair | undefined> {
    return loadKey(path.join(this.reservedKeyDir, signingKeyOrDid))
  }

  async clearReservedKeypair(keyDid: string, did?: string) {
    await rmIfExists(path.join(this.reservedKeyDir, keyDid))
    if (did) {
      await rmIfExists(path.join(this.reservedKeyDir, did))
    }
  }

  async storePlcOp(did: string, op: Uint8Array) {
    const { directory } = await this.getLocation(did)
    const opLoc = path.join(directory, `did-op`)
    await fs.writeFile(opLoc, op)
  }

  async getPlcOp(did: string): Promise<Uint8Array> {
    const { directory } = await this.getLocation(did)
    const opLoc = path.join(directory, `did-op`)
    return await fs.readFile(opLoc)
  }

  async clearPlcOp(did: string) {
    const { directory } = await this.getLocation(did)
    const opLoc = path.join(directory, `did-op`)
    await rmIfExists(opLoc)
  }
}

const loadKey = async (loc: string): Promise<ExportableKeypair | undefined> => {
  const privKey = await readIfExists(loc)
  if (!privKey) return undefined
  return crypto.Secp256k1Keypair.import(privKey, { exportable: true })
}

const keypairFromDb = async (db: ActorDb): Promise<Keypair> => {
  const row = await db.db
    .selectFrom('actor_key')
    .select('privKey')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow()
  return crypto.Secp256k1Keypair.import(row.privKey)
}

const keypairFromDisk = async (keyLocation: string): Promise<Keypair> => {
  const privKey = await fs.readFile(keyLocation)
  return crypto.Secp256k1Keypair.import(privKey)
}

function assertSafePathPart(part: string) {
  const normalized = path.normalize(part)
  assert(
    part === normalized &&
      !part.startsWith('.') &&
      !part.includes('/') &&
      !part.includes('\\'),
    `unsafe path part: ${part}`,
  )
}
