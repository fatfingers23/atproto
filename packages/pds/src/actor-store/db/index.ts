import { TursoDbConfig } from '../../config'
import { Database, Migrator } from '../../db'
import migrations from './migrations'
import { DatabaseSchema } from './schema'
export * from './schema'

export type ActorDb = Database<DatabaseSchema>

export type ActorDbOpts = {
  location: string
  disableWalAutoCheckpoint?: boolean
  turso?: TursoDbConfig | null
}

export const getDb = (opts: ActorDbOpts): ActorDb => {
  if (opts.turso) {
    return Database.libsql(opts.turso.url, opts.turso.authToken)
  }
  const pragmas: Record<string, string> = opts.disableWalAutoCheckpoint
    ? { wal_autocheckpoint: '0' }
    : {}
  return Database.sqlite(opts.location, { pragmas })
}

export const getMigrator = (db: Database<DatabaseSchema>) => {
  return new Migrator(db.db, migrations)
}
