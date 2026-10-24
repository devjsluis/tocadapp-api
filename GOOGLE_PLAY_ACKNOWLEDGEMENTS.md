# Google Play: durable acknowledgement recovery

Apply migrations **035, 036, then 037**, before starting this backend build. 037
creates `google_play_acknowledgements` and seeds candidates from saved Google
Play subscriptions whose token owner agrees with the subscription owner. It does
not grant access, change subscriptions, infer owners, or contact Google.

Eligible subscription writes enqueue acknowledgement in the same transaction.
After commit, the acknowledgement worker re-fetches Google under the same ordered
advisory token locks as subscription synchronization. It checks the saved owner,
all linked anchors, user existence, replacement markers, purchase state and expiry.
It holds those locks through the acknowledgement call. Recovery never calls the
subscription writer and never changes Premium access.

`COMPLETED` means Google returned success for acknowledge or reported the purchase
already acknowledged. `RETRY` retains failed attempts; `DEFERRED` retains ownership
or eligibility problems; `SKIPPED` means an irreversibly replaced token. Only
`COMPLETED` has `completed_at`. Reasons are safe codes; raw Google errors/tokens
are not stored in the reason field. A crash after Google's success is recovered
by checking Google's acknowledgement state. Exactly-once HTTP delivery cannot be
promised, but completed local jobs and fresh Google reads prevent normal duplicate
acknowledgement calls.

Run `npm run build`, then `npm run reconcile:google-play`. This is the existing
single command: it services acknowledgement jobs independently, then the RTDN
inbox. Discovery also runs on every acknowledgement batch so purchases written
by an older backend during rollout are not missed. Existing completed jobs are
never reset. Candidates include locally expired subscriptions: Google's current
state determines whether acknowledgement is eligible, without reactivating access.

Each invocation processes up to 100 acknowledgement jobs and 100 RTDN items,
ordered by oldest attempt. No daemon/cron is installed by this change. Schedule
this command using the deployment's existing scheduler (for example every five
minutes), monitor nonzero exit codes and RETRY/DEFERRED counts, and run enough
batches to drain the initial historical backlog promptly. Overlapping invocations
are safe, though they may wait on the same tokens. Deferred/failed jobs are retried
on subsequent invocations without exponential backoff. Very old tokens can be
unavailable from Google and remain RETRY for manual review.

A Google outage leaves a durable obligation even when its error details cannot be
persisted during a database outage. Remote acknowledgement and the database cannot
commit atomically; retry always consults Google before another acknowledgement.
Token locks serialize local writers, not state changes initiated inside Google.
First-claim identity for a previously unowned token remains the existing app
verification policy; this worker never creates or transfers token ownership.

## Tests

`npm test` runs mocked Google/DB tests and skips the PostgreSQL suite unless
`GOOGLE_PLAY_TEST_DATABASE_URL` is explicitly set. The PostgreSQL suite refuses
non-loopback hosts and any database name other than `tocadapp_ack_test`; it never
loads `.env` or `DATABASE_URL`. Use a disposable local instance and database, then:

```powershell
$env:GOOGLE_PLAY_TEST_DATABASE_URL = 'postgresql://tocadapp_ack_test@127.0.0.1:55439/tocadapp_ack_test'
node --test tests/google-play-acknowledgement-postgres.test.cjs
Remove-Item Env:GOOGLE_PLAY_TEST_DATABASE_URL
```

It creates/drops its own unique schema, runs the actual 035/036/037 SQL, substitutes
only Google transport, and verifies transaction rollback, historical recovery,
owner/state exclusions, simultaneous workers and a replacement blocked by a real
PostgreSQL advisory lock. No Google credentials or real purchases are used.
