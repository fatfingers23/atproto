import fs from 'node:fs/promises'
import type { AtpAgent } from '@atproto/api'
import { DAY } from '@atproto/common'
import { randomStr } from '@atproto/crypto'
import {
  type SeedClient,
  TestNetworkNoAppView,
  TestPds,
  mockNetworkUtilities,
} from '@atproto/dev-env'
import type { DidString } from '@atproto/syntax'
import userSeed from './seeds/basic.js'

describe('rate limits', () => {
  let network: TestNetworkNoAppView
  let agent: AtpAgent
  let sc: SeedClient
  let alice: string
  let bob: string

  beforeAll(async () => {
    network = await TestNetworkNoAppView.create({
      dbPostgresSchema: 'rate_limits',
      pds: {
        redisScratchAddress: process.env.REDIS_HOST,
        redisScratchPassword: process.env.REDIS_PASSWORD,
        rateLimitsEnabled: true,
      },
    })
    agent = network.pds.getAgent()
    sc = network.getSeedClient()
    await userSeed(sc)
    alice = sc.dids.alice
    bob = sc.dids.bob
  })

  afterAll(async () => {
    await network?.close()
  })

  it('rate limits by ip', async () => {
    const attempt = () =>
      agent.api.com.atproto.server.resetPassword({
        token: randomStr(4, 'base32'),
        password: 'asdf1234',
      })
    for (let i = 0; i < 50; i++) {
      try {
        await attempt()
      } catch (err) {
        // do nothing
      }
    }
    await expect(attempt).rejects.toThrow('Rate Limit Exceeded')
  })

  it('rate limits by a custom key', async () => {
    const attempt = () =>
      agent.api.com.atproto.server.createSession({
        identifier: sc.accounts[alice].handle,
        password: 'asdf1234',
      })
    for (let i = 0; i < 30; i++) {
      try {
        await attempt()
      } catch (err) {
        // do nothing
      }
    }
    await expect(attempt).rejects.toThrow('Rate Limit Exceeded')

    // does not rate limit for another key
    await agent.api.com.atproto.server.createSession({
      identifier: sc.accounts[bob].handle,
      password: sc.accounts[bob].password,
    })
  })

  describe('migration uploads', () => {
    let oldPds: TestPds
    let oldAgent: AtpAgent
    let newAgent: AtpAgent
    let migrator: DidString
    let createdAt: string
    let deactivatedAt: string
    let images: Uint8Array[]

    // The per-IP upload budget is shared by every account in this suite (all
    // requests come from the same ip), so track it across users.
    let ipRemaining: number

    const randomBlob = () => Buffer.from(randomStr(64, 'base32'))

    const upload = async (
      as: AtpAgent,
      bytes: Uint8Array,
      headers?: Record<string, string>,
    ) => {
      const res = await as.com.atproto.repo.uploadBlob(bytes, {
        encoding: 'application/octet-stream',
        headers,
      })
      return Number(res.headers['ratelimit-remaining'])
    }

    // An upload that is expected to consume the per-IP budget.
    const expectNormalUpload = async (
      as: AtpAgent,
      bytes: Uint8Array,
      headers?: Record<string, string>,
    ) => {
      const remaining = await upload(as, bytes, headers)
      ipRemaining -= 1
      expect(remaining).toBe(ipRemaining)
    }

    // An upload that is expected to leave the per-IP budget untouched.
    const expectMigrationUpload = async (as: AtpAgent, bytes: Uint8Array) => {
      const remaining = await upload(as, bytes)
      // The tightest remaining bucket is no longer the per-IP one
      expect(remaining).toBeGreaterThan(ipRemaining)
    }

    const setActor = (values: {
      createdAt?: string
      deactivatedAt?: string | null
    }) =>
      network.pds.ctx.accountManager.db.db
        .updateTable('actor')
        .set(values)
        .where('did', '=', migrator)
        .execute()

    beforeAll(async () => {
      // The pds the migrating account comes from. Rate limits are only enabled on the
      // destination (network.pds).
      oldPds = await TestPds.create({ didPlcUrl: network.plc.url })
      mockNetworkUtilities(oldPds)
      oldAgent = oldPds.getAgent()
      const created = await oldAgent.createAccount({
        handle: 'migrator.test',
        email: 'migrator@test.com',
        password: 'migrator-pass',
      })
      migrator = created.data.did as DidString

      images = await Promise.all([
        fs.readFile('../dev-env/assets/key-alt.jpg'),
        fs.readFile('../dev-env/assets/key-landscape-small.jpg'),
      ])
      for (const image of images) {
        const res = await oldAgent.com.atproto.repo.uploadBlob(image, {
          encoding: 'image/jpeg',
        })
        await oldAgent.app.bsky.feed.post.create(
          { repo: migrator },
          {
            text: 'migrate me',
            embed: {
              $type: 'app.bsky.embed.images',
              images: [{ image: res.data.blob, alt: '' }],
            },
            createdAt: new Date().toISOString(),
          },
        )
      }

      // Create the (deactivated) account on the new pds and import the repo
      const serviceJwt = await oldAgent.com.atproto.server.getServiceAuth({
        aud: network.pds.ctx.cfg.service.did,
        lxm: 'com.atproto.server.createAccount',
      })
      newAgent = network.pds.getAgent()
      await newAgent.com.atproto.server.createAccount(
        {
          handle: 'migrator-new.test',
          email: 'migrator@test.com',
          password: 'migrator-pass',
          did: migrator,
        },
        {
          headers: { authorization: `Bearer ${serviceJwt.data.token}` },
          encoding: 'application/json',
        },
      )
      await newAgent.login({
        identifier: 'migrator-new.test',
        password: 'migrator-pass',
      })
      const repo = await oldAgent.com.atproto.sync.getRepo({ did: migrator })
      await newAgent.com.atproto.repo.importRepo(repo.data, {
        encoding: 'application/vnd.ipld.car',
      })

      const account = await network.pds.ctx.accountManager.getAccount(
        migrator,
        {
          includeDeactivated: true,
        },
      )
      createdAt = account!.createdAt
      deactivatedAt = account!.deactivatedAt!
    })

    afterAll(async () => {
      await oldPds?.close()
    })

    it('budgets migration uploads per did instead of per ip', async () => {
      const aliceHeaders = sc.getHeaders(alice)
      const status = await newAgent.com.atproto.server.checkAccountStatus()
      expect(status.data).toMatchObject({
        activated: false,
        expectedBlobs: 2,
        importedBlobs: 0,
      })

      // Baseline: an ordinary upload reports the per-IP budget
      ipRemaining = await upload(agent, randomBlob(), aliceHeaders)

      // Past the migration window: per-IP budget, even though the account is
      // deactivated and still missing blobs
      await setActor({
        createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
      })
      await expectNormalUpload(newAgent, randomBlob())
      await setActor({ createdAt })

      // Activated (not migrating): per-IP budget, even with missing blobs
      await setActor({ deactivatedAt: null })
      await expectNormalUpload(newAgent, randomBlob())
      await setActor({ deactivatedAt })

      // Mid-migration: per-DID budget, per-IP budget untouched
      await expectMigrationUpload(newAgent, images[0])
      await expectNormalUpload(agent, randomBlob(), aliceHeaders)
      await expectMigrationUpload(newAgent, images[1])
      await expectNormalUpload(agent, randomBlob(), aliceHeaders)

      const missing = await newAgent.com.atproto.repo.listMissingBlobs()
      expect(missing.data.blobs).toHaveLength(0)

      // Nothing left to migrate: back to the per-IP budget
      await expectNormalUpload(newAgent, randomBlob())
    })
  })
})
