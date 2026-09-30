---
'@atproto/xrpc-server': patch
'@atproto/pds': patch
---

Rate limit `com.atproto.repo.uploadBlob` per DID (5000/day) instead of per IP (1000/day) for accounts that are mid-migration: deactivated, created less than 24 hours ago, and still missing blobs referenced by their records. `calcKey` and `calcPoints` rate limit callbacks may now be async.
