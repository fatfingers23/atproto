import { createClient } from '@tursodatabase/api'
import { TursoActorStoreConfig } from '../config'

type TursoApiClient = ReturnType<typeof createClient>

// The SDK's CJS build only re-exports createClient (TursoClientError is not
// reachable as a named export). Detect the error structurally — the class
// sets `this.name = "TursoClientError"` and a numeric `status`.
const isTursoNotFound = (err: unknown): boolean => {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'TursoClientError' &&
    (err as { status?: unknown }).status === 404
  )
}

export class TursoPlatformClient {
  client: TursoApiClient

  constructor(public cfg: TursoActorStoreConfig) {
    this.client = createClient({
      org: cfg.orgSlug,
      token: cfg.apiToken,
    })
  }

  async createDatabase(name: string): Promise<{ hostname: string }> {
    const created = await this.client.databases.create(name, {
      group: this.cfg.group,
    })
    return { hostname: created.hostname }
  }

  async deleteDatabase(name: string): Promise<void> {
    await this.client.databases.delete(name)
  }

  async databaseExists(name: string): Promise<boolean> {
    try {
      await this.client.databases.get(name)
      return true
    } catch (err) {
      if (isTursoNotFound(err)) return false
      throw err
    }
  }

  buildDatabaseUrl(name: string, hostname?: string): string {
    return this.cfg.dbUrlTemplate
      .replace('{name}', name)
      .replace('{org}', this.cfg.orgSlug)
      .replace('{hostname}', hostname ?? '')
  }
}
