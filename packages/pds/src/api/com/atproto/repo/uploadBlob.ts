import { DAY } from '@atproto/common'
import type { DidString } from '@atproto/syntax'
import {
  type Server,
  UpstreamTimeoutError,
  parseReqEncoding,
} from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import { com } from '../../../../lexicons/index.js'

/**
 * Accounts created through the migration flow (deactivated on creation) get a
 * per-DID upload budget for this long after creation, instead of the per-IP
 * budget. Combined with the daily per-DID limiter, this bounds the number of
 * migration uploads a single account can ever obtain.
 */
const MIGRATION_WINDOW_MS = DAY

export default function (server: Server, ctx: AppContext) {
  // Memoized per request so that both limiters share a single lookup.
  const migrationUploads = new WeakMap<object, Promise<boolean>>()
  const isMigrationUpload = (
    handlerCtx: object,
    did: DidString,
  ): Promise<boolean> => {
    let result = migrationUploads.get(handlerCtx)
    if (!result) {
      result = checkMigrationUpload(ctx, did)
      migrationUploads.set(handlerCtx, result)
    }
    return result
  }

  server.add(com.atproto.repo.uploadBlob, {
    auth: ctx.authVerifier.authorizationOrUserServiceAuth({
      checkTakedown: true,
      authorize: (permissions, { req }) => {
        const encoding = parseReqEncoding(req)
        permissions.assertBlob({ mime: encoding })
      },
    }),
    rateLimit: [
      // Normal uploads: per-IP budget. Skipped for migration uploads.
      {
        durationMs: DAY,
        points: 1000,
        calcPoints: async (c) =>
          (await isMigrationUpload(c, c.auth.credentials.did)) ? 0 : 1,
      },
      // Migration uploads: per-DID budget. Skipped for normal uploads.
      {
        durationMs: DAY,
        points: 5000,
        calcKey: ({ auth }) => auth.credentials.did,
        calcPoints: async (c) =>
          (await isMigrationUpload(c, c.auth.credentials.did)) ? 1 : 0,
      },
    ],
    handler: async ({ auth, input }) => {
      const requester = auth.credentials.did

      const blob = await ctx.actorStore.writeNoTransaction(
        requester,
        async (store) => {
          const metadata = await store.repo.blob
            .uploadBlobAndGetMetadata(
              input.body,
              input.encoding,
              ctx.cfg.service.blobUploadLimit,
            )
            .catch(throwAbortAsUpstreamError)

          return store.transact(async (actorTxn) => {
            const blobRef =
              await actorTxn.repo.blob.trackUntetheredBlob(metadata)

            // make the blob permanent if an associated record is already indexed
            if (await actorTxn.repo.blob.hasRecordsForBlob(blobRef.ref)) {
              await actorTxn.repo.blob.verifyBlobAndMakePermanent(blobRef)
            }

            return blobRef
          })
        },
      )

      return {
        encoding: 'application/json' as const,
        body: { blob },
      }
    },
  })
}

/**
 * An upload counts as a migration upload when the account is still
 * deactivated, was created less than {@link MIGRATION_WINDOW_MS} ago, and has
 * at least one blob referenced by its records that has not been uploaded yet.
 */
async function checkMigrationUpload(
  ctx: AppContext,
  did: DidString,
): Promise<boolean> {
  const account = await ctx.accountManager.getAccount(did, {
    includeDeactivated: true,
  })
  if (!account?.deactivatedAt) return false
  if (Date.now() - Date.parse(account.createdAt) >= MIGRATION_WINDOW_MS) {
    return false
  }
  return ctx.actorStore.read(did, async (store) => {
    const missing = await store.repo.blob.listMissingBlobs({ limit: 1 })
    return missing.length > 0
  })
}

function throwAbortAsUpstreamError(err: unknown): never {
  // Blob store timeouts surface as AbortError (total upload timeout) or
  // TimeoutError (stalled connection), possibly wrapped as an error cause
  // (e.g. S3BlobStore's "Blob upload timed out" error). The depth limit
  // guards against (pathological) cyclic cause chains.
  for (let e = err, depth = 0; e instanceof Error && depth < 10; depth++) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      throw new UpstreamTimeoutError('Operation timed out, please try again.')
    }
    e = e.cause
  }
  throw err
}
