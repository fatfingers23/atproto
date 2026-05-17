import { TursoDbConfig } from '../../config'
import { Database, Migrator } from '../../db'
import migrations from './migrations'
import { DatabaseSchema } from './schema'

export * from './schema'

export type AccountDb = Database<DatabaseSchema>

export type AccountDbOpts = {
  location: string
  disableWalAutoCheckpoint?: boolean
  turso?: TursoDbConfig | null
}

export const getDb = (opts: AccountDbOpts): AccountDb => {
  if (opts.turso) {
    return Database.libsql(opts.turso.url, opts.turso.authToken)
  }
  const pragmas: Record<string, string> = opts.disableWalAutoCheckpoint
    ? { wal_autocheckpoint: '0' }
    : {}
  return Database.sqlite(opts.location, { pragmas })
}

export const getMigrator = (db: AccountDb) => {
  return new Migrator(db.db, migrations)
}
