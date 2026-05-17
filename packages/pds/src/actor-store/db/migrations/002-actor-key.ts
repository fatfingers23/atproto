import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('actor_key')
    .addColumn('id', 'integer', (col) =>
      col.primaryKey().check(sql`id = 1`),
    )
    .addColumn('privKey', 'blob', (col) => col.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('actor_key').execute()
}
