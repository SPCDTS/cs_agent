> 统一 GitHub App、多账号/组织安装、长期授权与迁移见 docs/GITHUB-APP-DESIGN.md。本文的逐仓库 Webhook 仅适用于显式配置 GITHUB_MODE=manual 的 legacy 模式；模式未配置一律拒收。

# GitHub webhook event source

## Scope and safety

GitHub → signed, durable receipt in EventsDO → repository/action policy, merge window,
quiet hours and hourly budget → owner Thread event → existing Bridge QQ delivery.
No GitHub API credential is required, no webhook is created automatically, and no MCP
eventAllow permission is added. Payload routing fields are ignored. External titles are
untrusted material, never instructions or authority to perform external actions.

The first initialized allowlist is **only SPCDTS/cs_agent**. Saving an empty list disables
all repositories and remains empty after restart. Supported selections:

- issues: opened, reopened, closed
- pull_request: opened, reopened, closed, ready_for_review
- release: published
- workflow_run: completed (all conclusions; opt-in, potentially noisy)
- push (opt-in, potentially noisy)

Default selections are issues.opened, pull_request.opened,
pull_request.ready_for_review and release.published. Ping is recorded as suppressed.
Other event shapes are rejected with 400; choose only supported event families in GitHub.

## Operator setup (not performed by this change)

1. Deploy the reviewed code using the existing deployment process, not as part of testing.
2. Store a high-entropy shared secret with the existing Worker secret mechanism:
   run `wrangler secret put GITHUB_WEBHOOK_SECRET` from workers, or use Cloudflare's
   secret UI. Never place the value in vars, source, normal settings, logs or chat.
   The admin UI exposes only whether it is configured; it does not accept or return it.
3. In the admin web UI → tasks/events → GitHub event settings, review repositories,
   event/actions, merge seconds, hourly budget, quiet hours (Beijing time) and pause.
   Save uses a revision CAS: a stale save returns 409 and retains the editor;
   explicitly discard/reload before retrying. Saving this list **does not register a webhook**.
4. In EACH allowed GitHub repository: Settings → Webhooks → Add webhook.
   Payload URL: `https://<public-worker-origin>/github/webhook`.
   Content type: application/json. Secret: the same Worker secret. Enable SSL
   verification. Select individual supported event families and keep Active checked.
   Organization webhooks/GitHub Enterprise/custom domains are outside this scope.
5. Check the GitHub ping response and a supported event, then inspect admin receipts.
   A ping proves receipt/signature handling, not LLM execution or QQ delivery.

Removing a GitHub webhook is an operator action in GitHub. Removing its repository
from this UI instead revokes local policy and suppresses new deliveries.

## Receipt protocol and limits

- Only POST /github/webhook; missing secret fails closed (503).
- Raw bytes bounded to 256 KiB, streamed with a five-second read deadline.
  Header formats/lengths, repository identity and selected event shapes are bounded.
  HMAC-SHA256 is verified using Web Crypto verify before UTF-8 decoding / JSON parsing.
  The whole ingress response has a nine-second deadline; timeout/failure is non-2xx.
  A hard platform stall/network delay cannot be guaranteed below GitHub's ten seconds.
- A durable alarm is armed BEFORE a synchronous SQLite transaction inserts the receipt
  and normalized held event. Storage sync completes before 202. There is no
  waitUntil-then-ack path and the endpoint does not wait for a model or QQ.
  Cron is a second recovery path. A crash may result in a stored receipt and a failed
  HTTP response: Redeliver will find it, not enqueue it again.
- Receipt stores original delivery ID, raw-body SHA-256, repository name and numeric ID,
  event/action, server receipt/update timestamps, state, suppression reason, event key,
  batch input key and turn outcome. Raw body, issue/PR body, secrets, arbitrary supplied
  URLs and routing fields are not persisted. The held event stores only bounded title,
  actor, short summary and a constructed https://github.com URL.
- Same delivery ID/same body: 200 duplicate. Same ID/different body: 409 conflict.
  Different ID/same body: 200 body_duplicate, coalesced into the original receipt.
  Hash uniqueness is GLOBAL, never partitioned by unsigned event/delivery headers.
  Alternate delivery IDs are not stored as aliases; inspect the original receipt/hash.
  This deliberately coalesces byte-identical legitimate bodies as well as replays.
- At most 200 pending receipts (held/enqueued/started) and 5000 total receipts.
  At capacity return 503; older pending work is NEVER evicted for GitHub.
  Gmail's existing 200-held eviction behavior is unchanged. Pausing retains pending
  receipts and can fill this capacity. There is no background overflow log pretending
  an unaccepted delivery was accepted.
- Terminal receipts are retained for 30 days after terminal update, pruned on receipt
  or periodic processing; pending receipts are not expired. A replay after retention
  is not protected by the receipt hash guarantee. Thread's own request-ID retention
  can further coalesce it but must not be treated as infinite replay prevention.
  High volume can fill 5000 records before 30 days; reduce event selection and
  arrange manual Redeliver after capacity is available. This is a low-volume source.

## Policy, identity, revocation and execution boundary

Repository names are matched case-insensitively. The first accepted, signed event
pins that name to the numeric repository ID present in the body. **This is trust on
first signed delivery, NOT independent GitHub API verification.** Pins survive removal
and re-addition, preventing silent acceptance of a different repository reusing a name.
Renames/transfers require an explicit new allowed name and first delivery for it.
There is deliberately no automatic unpin/rebind button: a legitimate name reused by a
different ID needs an operator-reviewed storage migration after verifying ownership.
Pin tombstones are bounded to 1000; see capacity response if that limit is reached.

Configuration changes synchronously re-check held and enqueued receipts. Removed
repositories or selections are permanently suppressed and do not revive when re-added
or Redelivered. If one member of an already-enqueued batch is revoked, the entire
not-yet-authorized batch is suppressed (other members use batch_revoked): immutable
Thread input is not edited behind a stable request ID.

GitHub work is not admitted into Harness's busy queue. When the owner runtime is idle,
Thread asks EventsDO for an atomic execution permit and re-checks current policy.
Pause returns wait and leaves the Thread input pending. Source auto-pause after repeated
failed turns continues to apply. **The irrevocable boundary is issuing this permit,
not the first model token or the final QQ send.** A config edit immediately after a
permit, or a crash between permit and submission, cannot revoke that permit: recovery
reuses the stable request ID rather than risking duplicate execution or ambiguous undo.
Already-executing work and delivered QQ messages cannot be recalled through this UI.

Over-budget GitHub events keep their full bounded normalized records and resume at
budget expiry even if no new delivery arrives. Gmail's legacy folded-count behavior is
unchanged. Normal merge batches contain at most ten events.

## Status and operations

Authenticated `GET /admin/event-sources` contains:
- source state/budget, GitHub config + revision and secret-configured boolean;
- receipt capacity/counts, pinned repository IDs, newest 50 receipt metadata records.

Authenticated `GET /admin/github/receipts/<delivery-id>` retrieves a retained original
receipt. No endpoint returns the shared secret or raw payload.

Receipt states:
- held: committed, waiting for policy/merge/quiet/budget/pause;
- enqueued: stable batch assigned; held copy retained until Thread admission ACK;
- started: atomic execution permit issued (may be recovering);
- finished: event turn outcome reported/reconciled;
- suppressed: terminal policy/ping/source-filter/batch-revocation reason.

An alarm/DO restart retries stable batch admission. A lost finish notification is
reconciled through Thread.eventOutcome by the existing EventsDO reconciliation path.
No state means “automatically retry an unknown QQ send”.

### Known event_run / QQ semantic limitation (not fixed here)

Thread.eventStatus currently labels a completed event sent if an outbox row exists,
otherwise silent. Outbox projection is written only for Bridge state sent.
A Bridge intent can still be queued/sending/unknown when the model turn completes,
so an event_run (and receipt outcome) can say silent and QQ can later be sent.
finishRun updates only queued runs; that historical label is not repaired later.
Therefore **silent is not proof that nothing was/will be sent**; finished is not a
delivery receipt. Check existing Bridge delivery records / outgoing intents as the
authority. Do NOT Redeliver or resend merely because an event outcome is silent.
This PR documents the pre-existing issue rather than redesigning the run/outbox model.
Bridge unknown states retain the existing no-blind-retry semantics.

### Failed deliveries / manual Redeliver

GitHub does not automatically redeliver failed webhook deliveries. On non-2xx or timeout,
use repository Settings → Webhooks → selected webhook → Recent deliveries → Redeliver,
after correcting the secret/schema/policy/capacity/runtime problem. Preserve delivery
identity; never edit headers to bypass deduplication. If the first HTTP response was
lost after persistence, Redeliver is safe within receipt retention. Suppressed receipts
are terminal and a Redeliver will NOT resurrect them.

Review 409 delivery_conflict as suspicious or a sender error. On repository_id_changed,
verify repository identity out of band; do not blindly clear pins. On receipt_capacity,
pending_capacity or pin_capacity, inspect counts and pause/turn states; do not delete
pending rows to make space. On unsupported_or_invalid_event, correct webhook family
selection or request an explicit adapter enhancement.

## Validation boundaries

Local tests exercise signature vectors, body/header bounds, dedup/conflict, global
hash replay protection, policy and empty-list CAS, identity pins, pause/capacity,
transaction rollback, restart recovery and owner-thread admission. Actual GitHub delivery
timing, production Worker secrets, live webhook registration, LLM behavior and QQ delivery
are NOT verified by these tests and require an operator-controlled post-deploy smoke test.
No real GitHub webhook is created/changed and no deployment occurs during development.

Sources:
https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
https://docs.github.com/en/webhooks/using-webhooks/redelivering-webhooks


## 当前边界（本次管理台迁移不扩展）

- 管理台收件分页只覆盖最新 50 条，每页 10 条，不是全部保留收件的游标分页。较旧的保留收件可按 delivery ID 使用上述认证接口查询。
- push 的 `after` 当前仅接受 40 位小写十六进制 Git SHA-1；64 位 Git SHA-256 对象 ID 尚不支持，会返回 400。本限制不影响 webhook 使用 HMAC-SHA256 验签或收件使用 SHA-256 正文哈希。
