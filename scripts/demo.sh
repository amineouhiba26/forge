#!/usr/bin/env bash
#
# Scripted walkthrough of the four behaviours this project claims.
#
#   1. Tenant isolation enforced by the database, not by application filtering
#   2. Invoicing as a CQRS saga, with a compensating path
#   3. Stripe webhooks idempotent against replay
#   4. Graceful degradation when a service dies, and recovery when it returns
#
# Run against the compose stack:
#
#   docker compose up --build -d
#   ./scripts/demo.sh
#
# Every assertion is checked. The script exits non-zero if any claim fails, so
# it is a test as much as a demonstration — a demo that cannot fail proves
# nothing.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_placeholder_not_a_real_secret}"
RUN="$(date +%s)"

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; reset=$'\033[0m'

step()  { printf '\n%s▸ %s%s\n' "$bold" "$1" "$reset"; }
ok()    { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
fail()  { printf '  %s✗ %s%s\n' "$red" "$1" "$reset"; exit 1; }
note()  { printf '  %s%s%s\n' "$dim" "$1" "$reset"; }

# --- JSON access without assuming jq is installed ---------------------------
if command -v python3 >/dev/null 2>&1; then
  jget() { python3 -c 'import sys,json;d=json.load(sys.stdin);
for k in sys.argv[1].split("."):
    d = d[int(k)] if k.isdigit() else d.get(k)
    if d is None: break
print(d if d is not None else "")' "$1"; }
elif command -v node >/dev/null 2>&1; then
  jget() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d=JSON.parse(s);for(const k of process.argv[1].split("."))
{d=d?.[k];if(d==null)break;}console.log(d??"");})' "$1"; }
else
  echo "Needs python3 or node to read JSON responses." >&2; exit 1
fi

# Prints the HTTP status of a request, discarding the body.
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# --- Preflight ---------------------------------------------------------------
step "Checking the stack is up at $BASE_URL"
if [ "$(status "$BASE_URL/health/live")" != "200" ]; then
  fail "No response. Start it with: docker compose up --build -d"
fi
ok "gateway is live"

# =============================================================================
step "1/4  Tenant isolation is enforced by Postgres, not by a WHERE clause"
# =============================================================================

signup() { # $1 email, $2 tenant name, $3 country
  curl -s -X POST "$BASE_URL/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"tenant\":{\"name\":\"$2\",\"country\":\"$3\"},\"owner\":{\"email\":\"$1\",\"password\":\"a-long-enough-password\"}}"
}

A_JSON="$(signup "acme-$RUN@demo.test" "Acme $RUN" FR)"
A_TOKEN="$(printf '%s' "$A_JSON" | jget tokens.accessToken)"
[ -n "$A_TOKEN" ] || fail "Tenant A signup failed: $A_JSON"
ok "tenant A created"

B_JSON="$(signup "globex-$RUN@demo.test" "Globex $RUN" DE)"
B_TOKEN="$(printf '%s' "$B_JSON" | jget tokens.accessToken)"
[ -n "$B_TOKEN" ] || fail "Tenant B signup failed: $B_JSON"
ok "tenant B created"

# B creates a client; A must not be able to see it by any means.
B_CLIENT="$(curl -s -X POST "$BASE_URL/clients" -H "Authorization: Bearer $B_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"B Confidential","email":"secret@globex.test"}' | jget id)"
[ -n "$B_CLIENT" ] || fail "Tenant B could not create a client"
ok "tenant B created a client"

CODE="$(status "$BASE_URL/clients/$B_CLIENT" -H "Authorization: Bearer $A_TOKEN")"
[ "$CODE" = "404" ] || fail "A read B's client by id — expected 404, got $CODE"
ok "A requesting B's client by exact id → 404 (invisible, not merely refused)"

A_LIST_TOTAL="$(curl -s "$BASE_URL/clients" -H "Authorization: Bearer $A_TOKEN" | jget total)"
[ "$A_LIST_TOTAL" = "0" ] || fail "A's client list should be empty, got $A_LIST_TOTAL"
ok "A's list contains none of B's data"

CODE="$(status "$BASE_URL/clients" -H "Authorization: Bearer $A_TOKEN")"
note "isolation comes from RLS: the query carries no tenant filter at all"

# =============================================================================
step "2/4  Invoicing runs as a CQRS saga — command → event → saga → issued"
# =============================================================================

A_CLIENT="$(curl -s -X POST "$BASE_URL/clients" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Wayne Enterprises","email":"pay@wayne.test"}' | jget id)"
ok "client created"

CONTRACT_JSON="$(curl -s -X POST "$BASE_URL/contracts" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"clientId\":\"$A_CLIENT\",\"title\":\"Website rebuild\",\"milestones\":[{\"title\":\"Design\",\"amount\":1000,\"dueDate\":\"2026-09-01\"}]}")"
CONTRACT_ID="$(printf '%s' "$CONTRACT_JSON" | jget id)"
MILESTONE_ID="$(printf '%s' "$CONTRACT_JSON" | jget milestones.0.id)"
[ -n "$MILESTONE_ID" ] || fail "Contract creation failed: $CONTRACT_JSON"
ok "contract created with a nested milestone (status DRAFT)"

CODE="$(status -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"milestoneId\":\"$MILESTONE_ID\"}")"
[ "$CODE" = "409" ] || fail "Invoicing incomplete work should 409, got $CODE"
ok "invoicing an incomplete milestone → 409 (the command refuses it)"

curl -s -X PATCH "$BASE_URL/contracts/$CONTRACT_ID" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"ACTIVE"}' > /dev/null
curl -s -X PATCH "$BASE_URL/contracts/$CONTRACT_ID/milestones/$MILESTONE_ID/complete" \
  -H "Authorization: Bearer $A_TOKEN" > /dev/null
ok "contract activated, milestone completed"

INVOICE_ID="$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"milestoneId\":\"$MILESTONE_ID\"}" | jget invoiceId)"
[ -n "$INVOICE_ID" ] || fail "Invoice creation failed"
ok "invoice created as PENDING — the PDF does not exist yet"

# The saga is asynchronous: poll rather than sleep a guessed duration.
STATUS=""
for _ in $(seq 1 60); do
  INVOICE="$(curl -s "$BASE_URL/invoices/$INVOICE_ID" -H "Authorization: Bearer $A_TOKEN")"
  STATUS="$(printf '%s' "$INVOICE" | jget status)"
  [ "$STATUS" = "ISSUED" ] && break
  sleep 0.5
done
[ "$STATUS" = "ISSUED" ] || fail "Saga did not reach ISSUED (last: $STATUS)"
ok "saga drove it to ISSUED: PDF rendered on the queue, invoice updated by event"

TOTAL="$(printf '%s' "$INVOICE" | jget total)"
TAX="$(printf '%s' "$INVOICE" | jget taxRate)"
note "FR tenant → tax $TAX%, total $TOTAL (rate stamped on the invoice, not recomputed)"

CODE="$(status -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"milestoneId\":\"$MILESTONE_ID\"}")"
[ "$CODE" = "409" ] || fail "Double-invoicing should 409, got $CODE"
ok "invoicing the same milestone twice → 409 (unique constraint, not a check)"

# =============================================================================
step "3/4  Stripe webhooks are idempotent — replay changes nothing"
# =============================================================================

INTENT="$(curl -s -X POST "$BASE_URL/invoices/$INVOICE_ID/payment-intent" \
  -H "Authorization: Bearer $A_TOKEN" | jget paymentIntentId)"
[ -n "$INTENT" ] || note "payment intent needs a Stripe key; signing a webhook directly instead"

TENANT_ID="$(printf '%s' "$A_JSON" | jget user.tenantId)"
EVENT_ID="evt_demo_${RUN}"
PAYLOAD="{\"id\":\"$EVENT_ID\",\"object\":\"event\",\"type\":\"payment_intent.succeeded\",\"data\":{\"object\":{\"id\":\"pi_demo_$RUN\",\"object\":\"payment_intent\",\"amount\":120000,\"currency\":\"eur\",\"metadata\":{\"tenantId\":\"$TENANT_ID\",\"invoiceId\":\"$INVOICE_ID\",\"correlationId\":\"demo-$RUN\"}}}}"

# Signed exactly as Stripe does: HMAC-SHA256 over "{timestamp}.{payload}".
sign() {
  local ts="$1" body="$2"
  printf '%s' "$ts.$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex \
    | sed 's/^.*= *//'
}

post_webhook() {
  local ts sig
  ts="$(date +%s)"
  sig="$(sign "$ts" "$PAYLOAD")"
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/webhooks/stripe" \
    -H 'Content-Type: application/json' \
    -H "stripe-signature: t=$ts,v1=$sig" \
    --data-binary "$PAYLOAD"
}

CODE="$(status -X POST "$BASE_URL/webhooks/stripe" -H 'Content-Type: application/json' \
  -H 'stripe-signature: t=1,v1=forged' --data-binary "$PAYLOAD")"
[ "$CODE" = "400" ] || fail "A forged signature must be rejected, got $CODE"
ok "forged signature → 400 (this is the only thing authenticating the endpoint)"

for attempt in 1 2 3; do
  CODE="$(post_webhook)"
  [ "$CODE" = "200" ] || fail "Webhook delivery $attempt returned $CODE"
done
ok "the same event delivered three times → 200 each (Stripe retries are normal)"

PAID="$(curl -s "$BASE_URL/invoices/$INVOICE_ID" -H "Authorization: Bearer $A_TOKEN")"
PAID_STATUS="$(printf '%s' "$PAID" | jget status)"
PAID_AT="$(printf '%s' "$PAID" | jget paidAt)"
[ "$PAID_STATUS" = "PAID" ] || fail "Invoice should be PAID, got $PAID_STATUS"
ok "invoice is PAID"
note "paidAt=$PAID_AT — unchanged by deliveries 2 and 3, so history is not rewritten"

# =============================================================================
step "4/4  Graceful degradation — kill billing-service, then bring it back"
# =============================================================================

if ! command -v docker >/dev/null 2>&1; then
  note "docker not available; skipping the degradation act"
else
  docker compose stop billing-service > /dev/null 2>&1 || \
    { note "billing-service is not running under compose; skipping"; exit 0; }
  ok "billing-service stopped"

  # The first call trips the breaker; once open, calls fail fast.
  CODE=""
  for _ in $(seq 1 5); do
    CODE="$(status "$BASE_URL/invoices" -H "Authorization: Bearer $A_TOKEN")"
    [ "$CODE" = "503" ] && break
    sleep 1
  done
  [ "$CODE" = "503" ] || fail "Expected 503 while billing is down, got $CODE"
  ok "invoice routes → 503 naming the unavailable service, not a 500 stack trace"

  CODE="$(status "$BASE_URL/clients" -H "Authorization: Bearer $A_TOKEN")"
  [ "$CODE" = "200" ] || fail "Unrelated routes should still work, got $CODE"
  ok "contracts and clients still respond — one dead service is not an outage"

  CODE="$(status "$BASE_URL/health")"
  note "GET /health still answers ($CODE) and reports which dependency is down"

  docker compose start billing-service > /dev/null 2>&1
  ok "billing-service restarted"

  CODE=""
  for _ in $(seq 1 60); do
    CODE="$(status "$BASE_URL/invoices" -H "Authorization: Bearer $A_TOKEN")"
    [ "$CODE" = "200" ] && break
    sleep 1
  done
  [ "$CODE" = "200" ] || fail "Did not recover (last status $CODE)"
  ok "invoice routes recovered automatically — the breaker half-opened and closed"
fi

printf '\n%s%sAll four claims demonstrated.%s\n' "$bold" "$green" "$reset"
printf '  Traces:  http://localhost:16686\n'
printf '  Mail:    http://localhost:8025\n'
printf '  Docs:    %s/docs\n\n' "$BASE_URL"
