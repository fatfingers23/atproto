import { TursoActorStoreConfig } from '../config'

const API_BASE = 'https://api.turso.tech/v1'

export class TursoPlatformError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message)
  }
}

export class TursoPlatformClient {
  constructor(public cfg: TursoActorStoreConfig) {}

  async createDatabase(name: string): Promise<{ hostname: string }> {
    const body: Record<string, unknown> = { name }
    if (this.cfg.group) body.group = this.cfg.group
    const res = await this.request('POST', `/databases`, body)
    const hostname = res?.database?.Hostname ?? res?.database?.hostname
    if (typeof hostname !== 'string') {
      throw new TursoPlatformError(
        'unexpected create-database response shape',
        200,
        res,
      )
    }
    return { hostname }
  }

  async deleteDatabase(name: string): Promise<void> {
    await this.request('DELETE', `/databases/${encodeURIComponent(name)}`)
  }

  async databaseExists(name: string): Promise<boolean> {
    const res = await this.requestRaw(
      'GET',
      `/databases/${encodeURIComponent(name)}`,
    )
    if (res.status === 404) return false
    if (!res.ok) {
      throw new TursoPlatformError(
        `turso platform GET ${name} failed`,
        res.status,
        await safeJson(res),
      )
    }
    return true
  }

  buildDatabaseUrl(name: string, hostname?: string): string {
    return this.cfg.dbUrlTemplate
      .replace('{name}', name)
      .replace('{org}', this.cfg.orgSlug)
      .replace('{hostname}', hostname ?? '')
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<any> {
    const res = await this.requestRaw(method, path, body)
    const json = await safeJson(res)
    if (!res.ok) {
      throw new TursoPlatformError(
        `turso platform ${method} ${path} failed`,
        res.status,
        json,
      )
    }
    return json
  }

  private requestRaw(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${API_BASE}/organizations/${encodeURIComponent(
      this.cfg.orgSlug,
    )}${path}`
    return fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.apiToken}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
}

const safeJson = async (res: Response): Promise<any> => {
  try {
    return await res.json()
  } catch {
    return null
  }
}
