#!/usr/bin/env bash
#
# Fake vendor: sends signed webhooks to the Atlas ingest API.
#
# Signature scheme (must match apps/api/src/webhooks/hmac.ts):
#   Header  X-Webhook-Key: <keyId>
#   Header  X-Signature:   t=<unixSeconds>,v1=<hexHmacSha256>
#   signedString = "<t>.<rawBody>"
#   v1 = HMAC_SHA256(secret, signedString)  (lowercase hex)
#
# Usage:
#   ./scripts/webhook.sh                 # runs the full demo: valid, duplicate, bad-signature, fail->dead
#   ./scripts/webhook.sh send <id> <simulate>   # send one custom event
#
# Env overrides: API_BASE, KEY_ID, SECRET, VENDOR
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3333}"
VENDOR="${VENDOR:-stripe}"
KEY_ID="${KEY_ID:-acme_stripe_key}"
SECRET="${SECRET:-whsec_acme_stripe_dev}"   # matches prisma/seed.ts

sign() {
  # $1 = raw body, $2 = timestamp
  printf '%s.%s' "$2" "$1" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //'
}

post() {
  # $1 = body, $2 = signature-header-value
  curl -sS -w "\n  -> HTTP %{http_code}\n" \
    -X POST "$API_BASE/webhooks/$VENDOR" \
    -H "content-type: application/json" \
    -H "x-webhook-key: $KEY_ID" \
    -H "x-signature: $2" \
    -d "$1"
}

send_one() {
  local id="$1" simulate="${2:-ok}"
  local body t sig
  body="{\"id\":\"$id\",\"type\":\"charge.succeeded\",\"amount\":4200,\"simulate\":\"$simulate\"}"
  t="$(date +%s)"
  sig="t=$t,v1=$(sign "$body" "$t")"
  post "$body" "$sig"
}

demo() {
  local id="evt_demo_$(date +%s)"

  echo "== 1) VALID event ($id) =="
  send_one "$id" "ok"

  echo
  echo "== 2) DUPLICATE (same id, at-least-once retry) -> one work item =="
  send_one "$id" "ok"

  echo
  echo "== 3) BAD SIGNATURE -> 401 =="
  local body t
  body="{\"id\":\"${id}_bad\",\"type\":\"charge.succeeded\"}"
  t="$(date +%s)"
  post "$body" "t=$t,v1=deadbeefdeadbeef"

  echo
  echo "== 4) SIMULATED FAILURE -> bounded retries -> dead =="
  send_one "evt_demo_fail_$(date +%s)" "fail"

  echo
  echo "== 5) STALE timestamp (10 min old) -> 401 =="
  body="{\"id\":\"evt_demo_stale_$(date +%s)\",\"type\":\"charge.succeeded\"}"
  t="$(( $(date +%s) - 600 ))"
  post "$body" "t=$t,v1=$(sign "$body" "$t")"

  echo
  echo "== 6) OVERSIZED body (> 64 KiB) -> 413 =="
  local blob
  blob="$(head -c 70000 < /dev/zero | tr '\0' 'x')"
  body="{\"id\":\"evt_demo_big_$(date +%s)\",\"blob\":\"$blob\"}"
  t="$(date +%s)"
  post "$body" "t=$t,v1=$(sign "$body" "$t")"
}

case "${1:-demo}" in
  send) send_one "${2:?event id required}" "${3:-ok}" ;;
  demo) demo ;;
  *) echo "usage: $0 [demo | send <id> <ok|fail|fail-until:N>]" >&2; exit 1 ;;
esac
