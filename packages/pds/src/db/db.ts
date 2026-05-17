import assert from 'node:assert'
import SqliteDB from 'better-sqlite3'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import {
  Kysely,
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  SqliteDialect,
  UnknownRow,
  sql,
} from 'kysely'
import { dbLogger } from '../logger'
import { retrySqlite } from './util'

const DEFAULT_PRAGMAS = {
  // strict: 'ON', // @TODO strictness should live on table defs instead
}

export type DialectKind = 'sqlite' | 'libsql'

export class Database<Schema> {
  destroyed = false
  commitHooks: CommitHook[] = []

  constructor(
    public db: Kysely<Schema>,
    public dialectKind: DialectKind = 'sqlite',
  ) {}

  static sqlite<T>(
    location: string,
    opts?: { pragmas?: Record<string, string> },
  ): Database<T> {
    const sqliteDb = new SqliteDB(location, {
      timeout: 0, // handled by application
    })
    const pragmas = {
      ...DEFAULT_PRAGMAS,
      ...(opts?.pragmas ?? {}),
    }
    for (const pragma of Object.keys(pragmas)) {
      sqliteDb.pragma(`${pragma} = ${pragmas[pragma]}`)
    }
    const db = new Kysely<T>({
      dialect: new SqliteDialect({
        database: sqliteDb,
      }),
    })
    return new Database(db, 'sqlite')
  }

  static libsql<T>(url: string, authToken?: string): Database<T> {
    const db = new Kysely<T>({
      dialect: new LibsqlDialect({ url, authToken }),
      plugins: [new LibsqlBlobPlugin()],
    })
    return new Database(db, 'libsql')
  }

  async ensureWal() {
    // libsql is WAL-only; the pragma is unnecessary and not all backends accept it.
    if (this.dialectKind === 'libsql') return
    await sql`PRAGMA journal_mode = WAL`.execute(this.db)
  }

  async transactionNoRetry<T>(
    fn: (db: Database<Schema>) => T | PromiseLike<T>,
  ): Promise<T> {
    this.assertNotTransaction()
    const leakyTxPlugin = new LeakyTxPlugin()
    const { hooks, txRes } = await this.db
      .withPlugin(leakyTxPlugin)
      .transaction()
      .execute(async (txn) => {
        const dbTxn = new Database(txn, this.dialectKind)
        try {
          const txRes = await fn(dbTxn)
          leakyTxPlugin.endTx()
          const hooks = dbTxn.commitHooks
          return { hooks, txRes }
        } catch (err) {
          leakyTxPlugin.endTx()
          // ensure that all in-flight queries are flushed & the connection is open
          await txn.getExecutor().provideConnection(async () => {})
          throw err
        }
      })
    hooks.map((hook) => hook())
    return txRes
  }

  async transaction<T>(
    fn: (db: Database<Schema>) => T | PromiseLike<T>,
  ): Promise<T> {
    return retrySqlite(() => this.transactionNoRetry(fn))
  }

  async executeWithRetry<T>(query: { execute: () => Promise<T> }) {
    if (this.isTransaction) {
      // transaction() ensures retry on entire transaction, no need to retry individual statements.
      return query.execute()
    }
    return retrySqlite(() => query.execute())
  }

  onCommit(fn: () => void) {
    this.assertTransaction()
    this.commitHooks.push(fn)
  }

  get isTransaction() {
    return this.db.isTransaction
  }

  assertTransaction() {
    assert(this.isTransaction, 'Transaction required')
  }

  assertNotTransaction() {
    assert(!this.isTransaction, 'Cannot be in a transaction')
  }

  close(): void {
    if (this.destroyed) return
    this.db
      .destroy()
      .then(() => (this.destroyed = true))
      .catch((err) => dbLogger.error({ err }, 'error closing db'))
  }
}

type CommitHook = () => void

// libsql returns blob columns as ArrayBuffer; better-sqlite3 returns them as
// Buffer (a Uint8Array). Downstream consumers (e.g. CBOR decoders) assume the
// latter. Normalize ArrayBuffer values on rows coming back from libsql.
class LibsqlBlobPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node
  }

  async transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows
    for (const row of rows) {
      for (const key in row) {
        const val = row[key]
        if (val instanceof ArrayBuffer) {
          row[key] = new Uint8Array(val)
        }
      }
    }
    return args.result
  }
}

class LeakyTxPlugin implements KyselyPlugin {
  private txOver = false

  endTx() {
    this.txOver = true
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    if (this.txOver) {
      throw new Error('tx already failed')
    }
    return args.node
  }

  async transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    return args.result
  }
}
