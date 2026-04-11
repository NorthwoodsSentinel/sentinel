#!/usr/bin/env bash
# Gateway DNS Poller — feeds Cloudflare Gateway DNS logs to Sentinel
# Polls CF GraphQL API every INTERVAL seconds, transforms DNS query data
# into Sentinel telemetry events.
#
# Usage:
#   ./gateway-dns-poller.sh              # run once
#   ./gateway-dns-poller.sh --loop       # poll every 60s
#   ./gateway-dns-poller.sh --loop --interval 30

set -euo pipefail

# --- Config (override via environment or .env file) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/.env" ]] && source "$SCRIPT_DIR/.env"

CF_ACCOUNT="${CF_ACCOUNT:?Set CF_ACCOUNT in .env or environment}"
ZT_TOKEN_FILE="${ZT_TOKEN_FILE:-$HOME/.secrets/cf_zt_token}"
SENTINEL_URL="${SENTINEL_URL:?Set SENTINEL_URL in .env or environment}"
SENTINEL_CLIENT="${SENTINEL_CLIENT:-home}"
INTERVAL=60
LAST_POLL_FILE="/tmp/.sentinel-dns-last-poll"

# --- Args ---
LOOP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop) LOOP=true; shift ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# --- Load token ---
if [[ ! -f "$ZT_TOKEN_FILE" ]]; then
  echo "ERROR: ZT token not found at $ZT_TOKEN_FILE"
  exit 1
fi
ZT_TOKEN=$(cat "$ZT_TOKEN_FILE" | tr -d '\n\r ')

# --- Track last poll time ---
get_from_time() {
  # Always look back 5 minutes — the GraphQL API aggregates data
  # and short windows miss events that haven't been indexed yet
  date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ
}

save_poll_time() {
  date -u +%Y-%m-%dT%H:%M:%SZ > "$LAST_POLL_FILE"
}

# --- Poll and transform ---
poll_and_send() {
  local from_time=$(get_from_time)
  local now_ms=$(date +%s000)

  # Query Gateway DNS via GraphQL
  local response=$(curl -s "https://api.cloudflare.com/client/v4/graphql" \
    -H "Authorization: Bearer $ZT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "query": "{ viewer { accounts(filter: {accountTag: \"'"$CF_ACCOUNT"'\"}) { gatewayResolverQueriesAdaptiveGroups(filter: {datetime_gt: \"'"$from_time"'\"}, limit: 200, orderBy: [count_DESC]) { count dimensions { queryName categoryNames resolvedIps locationName matchedApplicationName resolverDecision } } } } }"
    }' 2>/dev/null)

  # Check for errors
  local has_errors=$(echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('yes' if d.get('errors') else 'no')
" 2>/dev/null)

  if [[ "$has_errors" == "yes" ]]; then
    echo "[$(date '+%H:%M:%S')] ERROR: GraphQL query failed"
    return 1
  fi

  # Transform to Sentinel events
  local events=$(echo "$response" | python3 -c "
import sys, json

data = json.load(sys.stdin)
groups = data['data']['viewer']['accounts'][0]['gatewayResolverQueriesAdaptiveGroups']

if not groups:
    print('[]')
    sys.exit()

import time
now_ms = int(time.time() * 1000)
events = []

# Total DNS query volume
total_queries = sum(g['count'] for g in groups)
events.append({
    'source': 'cloudflare-gateway',
    'timestamp': now_ms,
    'metric': 'dns_queries_total',
    'value': total_queries,
    'metadata': {'type': 'gauge', 'window': '60s'}
})

# Unique domains queried
events.append({
    'source': 'cloudflare-gateway',
    'timestamp': now_ms,
    'metric': 'dns_unique_domains',
    'value': len(groups),
    'metadata': {'type': 'gauge', 'window': '60s'}
})

# Per-domain query counts (top 20 by volume)
for g in groups[:20]:
    d = g['dimensions']
    domain = d['queryName']
    count = g['count']
    cats = d.get('categoryNames', [])
    app = d.get('matchedApplicationName', '')
    ips = d.get('resolvedIps', [])

    events.append({
        'source': 'cloudflare-gateway',
        'timestamp': now_ms,
        'metric': 'dns_domain_queries',
        'value': count,
        'metadata': {
            'domain': domain,
            'categories': ','.join(cats) if cats else '',
            'application': app or '',
            'resolved_ips': ','.join(ips[:3]) if ips else ''
        }
    })

# Category breakdown
cat_counts = {}
for g in groups:
    for cat in (g['dimensions'].get('categoryNames') or []):
        cat_counts[cat] = cat_counts.get(cat, 0) + g['count']

for cat, count in sorted(cat_counts.items(), key=lambda x: -x[1])[:10]:
    events.append({
        'source': 'cloudflare-gateway',
        'timestamp': now_ms,
        'metric': 'dns_category_queries',
        'value': count,
        'metadata': {'category': cat}
    })

# New/unusual domain detection — domains with very low query count
# These are potentially interesting (one-off lookups, beaconing, etc.)
rare_domains = [g for g in groups if g['count'] <= 2]
events.append({
    'source': 'cloudflare-gateway',
    'timestamp': now_ms,
    'metric': 'dns_rare_domains',
    'value': len(rare_domains),
    'metadata': {'type': 'gauge', 'threshold': '<=2 queries'}
})

print(json.dumps(events))
" 2>/dev/null)

  if [[ "$events" == "[]" ]]; then
    echo "[$(date '+%H:%M:%S')] No new DNS data"
    save_poll_time
    return 0
  fi

  # Count events
  local event_count=$(echo "$events" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")

  # Send to Sentinel
  local payload=$(python3 -c "
import sys, json, time
events = json.loads(sys.argv[1])
print(json.dumps({'events': events, 'ingested_at': int(time.time() * 1000)}))
" "$events")

  local result=$(curl -s -X POST "${SENTINEL_URL}/ingest?client=${SENTINEL_CLIENT}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1)

  local stored=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stored',0))" 2>/dev/null)
  local anomalies=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('anomalies',0))" 2>/dev/null)
  local proc_ms=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('processing_ms',0))" 2>/dev/null)

  # Get total queries from the data
  local total_queries=$(echo "$response" | python3 -c "
import sys, json
groups = json.load(sys.stdin)['data']['viewer']['accounts'][0]['gatewayResolverQueriesAdaptiveGroups']
print(sum(g['count'] for g in groups))
" 2>/dev/null)

  echo "[$(date '+%H:%M:%S')] DNS: ${total_queries} queries, ${event_count} events → Sentinel: ${stored} stored, ${anomalies} anomalies (${proc_ms}ms)"

  save_poll_time
}

# --- Main ---
echo "Sentinel Gateway DNS Poller v0.1.0"
echo "  Cloudflare Account: ${CF_ACCOUNT}"
echo "  Sentinel: ${SENTINEL_URL}?client=${SENTINEL_CLIENT}"
echo "  Interval: ${INTERVAL}s"
echo ""

if [[ "$LOOP" == "true" ]]; then
  echo "Starting continuous polling... (Ctrl+C to stop)"
  while true; do
    poll_and_send || echo "[$(date '+%H:%M:%S')] ERROR: poll failed"
    sleep "$INTERVAL"
  done
else
  poll_and_send
fi
