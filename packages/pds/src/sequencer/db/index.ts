import { TursoDbConfig } from '../../config'
import { Database, Migrator } from '../../db'
import migrations from './migrations'
import { SequencerDbSchema } from './schema'

export * from './schema'

export type SequencerDb = Database<SequencerDbSchema>

export type SequencerDbOpts = {
  location: string
  disableWalAutoCheckpoint?: boolean
  turso?: TursoDbConfig | null
}

export const getDb = (opts: SequencerDbOpts): SequencerDb => {
  if (opts.turso) {
    return Database.libsql(opts.turso.url, opts.turso.authToken)
  }
  const pragmas: Record<string, string> = opts.disableWalAutoCheckpoint
    ? { wal_autocheckpoint: '0' }
    : {}
  return Database.sqlite(opts.location, { pragmas })
}

export const getMigrator = (db: Database<SequencerDbSchema>) => {
  return new Migrator(db.db, migrations)
}
