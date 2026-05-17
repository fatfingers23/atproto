export interface ActorKey {
  id: 1
  privKey: Uint8Array
}

export const tableName = 'actor_key'

export type PartialDB = { [tableName]: ActorKey }
