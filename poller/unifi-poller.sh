#!/usr/bin/env bash
# UniFi Poller — feeds live network telemetry to Sentinel
# Runs on Lares, polls UDM Pro API every INTERVAL seconds,
# transforms client/device data into Sentinel telemetry events.
#
# Usage:
#   ./unifi-poller.sh                  # run once
#   ./unifi-poller.sh --loop           # poll every 60s
#   ./unifi-poller.sh --loop --interval 30  # custom interval
#
# Requires:
#   - UniFi API key in ~/.claude/.secrets/unifi_api_key
#   - curl, jq, bash 4+

set -euo pipefail

# --- Config ---
UNIFI_HOST="https://YOUR_UDM_IP"
UNIFI_SITE="YOUR_UNIFI_SITE_UUID"
SENTINEL_URL="https://your-sentinel.workers.dev"
SENTINEL_CLIENT="home"
KEY_FILE="$HOME/.claude/.secrets/unifi_api_key"
INTERVAL=60

# --- Args ---
LOOP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop) LOOP=true; shift ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# --- Load key ---
if [[ ! -f "$KEY_FILE" ]]; then
  echo "ERROR: UniFi API key not found at $KEY_FILE"
  exit 1
fi
UNIFI_KEY=$(cat "$KEY_FILE" | tr -d '\n')

# --- Functions ---

poll_clients() {
  curl -sk "${UNIFI_HOST}/proxy/network/integration/v1/sites/${UNIFI_SITE}/clients?limit=200" \
    -H "X-API-KEY: ${UNIFI_KEY}" \
    -H "Accept: application/json" 2>/dev/null
}

poll_devices() {
  curl -sk "${UNIFI_HOST}/proxy/network/integration/v1/sites/${UNIFI_SITE}/devices?limit=50" \
    -H "X-API-KEY: ${UNIFI_KEY}" \
    -H "Accept: application/json" 2>/dev/null
}

poll_device_stats() {
  local device_id="$1"
  curl -sk "${UNIFI_HOST}/proxy/network/integration/v1/sites/${UNIFI_SITE}/devices/${device_id}/statistics/latest" \
    -H "X-API-KEY: ${UNIFI_KEY}" \
    -H "Accept: application/json" 2>/dev/null
}

transform_and_send() {
  local now_ms=$(date +%s000)

  # Get clients
  local clients=$(poll_clients)
  local client_count=$(echo "$clients" | jq '.totalCount // 0')

  # Get devices + stats
  local devices=$(poll_devices)

  # Build telemetry events
  local events="[]"

  # Event 1: Total connected clients
  events=$(echo "$events" | jq --argjson ts "$now_ms" --argjson val "$client_count" \
    '. + [{"source":"unifi","timestamp":$ts,"metric":"connected_clients","value":$val,"metadata":{"type":"gauge"}}]')

  # Event 2: Per-type client counts
  local wireless_count=$(echo "$clients" | jq '[.data[] | select(.type=="WIRELESS")] | length')
  local wired_count=$(echo "$clients" | jq '[.data[] | select(.type=="WIRED")] | length')

  events=$(echo "$events" | jq --argjson ts "$now_ms" --argjson val "$wireless_count" \
    '. + [{"source":"unifi","timestamp":$ts,"metric":"wireless_clients","value":$val,"metadata":{"type":"gauge"}}]')
  events=$(echo "$events" | jq --argjson ts "$now_ms" --argjson val "$wired_count" \
    '. + [{"source":"unifi","timestamp":$ts,"metric":"wired_clients","value":$val,"metadata":{"type":"gauge"}}]')

  # Event 2b: Per-client device registration (sends identity data to Sentinel)
  # Use python to handle JSON safely — jq for-loops break on names with spaces
  local device_events=$(echo "$clients" | python3 -c "
import sys, json, time
data = json.load(sys.stdin)
ts = int(time.time() * 1000)
events = []
for c in data.get('data', []):
    mac = c.get('macAddress', '')
    if mac:
        events.append({
            'source': 'unifi',
            'timestamp': ts,
            'metric': 'device_heartbeat',
            'value': 1,
            'metadata': {
                'device_name': c.get('name', 'unnamed'),
                'mac_address': mac,
                'ip_address': c.get('ipAddress', ''),
                'device_type': c.get('type', 'unknown')
            }
        })
print(json.dumps(events))
" 2>/dev/null)

  if [[ -n "$device_events" && "$device_events" != "[]" ]]; then
    events=$(python3 -c "
import sys, json
existing = json.loads(sys.argv[1])
new = json.loads(sys.argv[2])
print(json.dumps(existing + new))
" "$events" "$device_events" 2>/dev/null)
  fi

  # Event 3: Device stats (CPU, memory, uptime for each device)
  for device_id in $(echo "$devices" | jq -r '.data[].id'); do
    local stats=$(poll_device_stats "$device_id")
    local device_name=$(echo "$devices" | jq -r --arg id "$device_id" '.data[] | select(.id==$id) | .name')

    local cpu=$(echo "$stats" | jq '.cpuUtilizationPct // 0')
    local mem=$(echo "$stats" | jq '.memoryUtilizationPct // 0')
    local uptime=$(echo "$stats" | jq '.uptimeSec // 0')

    events=$(echo "$events" | jq \
      --argjson ts "$now_ms" \
      --argjson cpu "$cpu" \
      --arg name "$device_name" \
      '. + [{"source":"unifi","timestamp":$ts,"metric":"device_cpu_pct","value":$cpu,"metadata":{"device":$name}}]')

    events=$(echo "$events" | jq \
      --argjson ts "$now_ms" \
      --argjson mem "$mem" \
      --arg name "$device_name" \
      '. + [{"source":"unifi","timestamp":$ts,"metric":"device_memory_pct","value":$mem,"metadata":{"device":$name}}]')
  done

  # Send to Sentinel
  local payload=$(jq -n --argjson events "$events" --argjson ts "$now_ms" \
    '{"events":$events,"ingested_at":$ts}')

  local result=$(curl -s -X POST "${SENTINEL_URL}/ingest?client=${SENTINEL_CLIENT}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1)

  local stored=$(echo "$result" | jq '.stored // 0')
  local anomalies=$(echo "$result" | jq '.anomalies // 0')
  local proc_ms=$(echo "$result" | jq '.processing_ms // 0')

  echo "[$(date '+%H:%M:%S')] Polled: ${client_count} clients, $(echo "$devices" | jq '.totalCount') devices → Sentinel: ${stored} events, ${anomalies} anomalies (${proc_ms}ms)"
}

# --- Main ---

echo "Sentinel UniFi Poller v0.1.0"
echo "  UDM Pro: ${UNIFI_HOST}"
echo "  Sentinel: ${SENTINEL_URL}?client=${SENTINEL_CLIENT}"
echo "  Interval: ${INTERVAL}s"
echo ""

if [[ "$LOOP" == "true" ]]; then
  echo "Starting continuous polling... (Ctrl+C to stop)"
  while true; do
    transform_and_send || echo "[$(date '+%H:%M:%S')] ERROR: poll failed"
    sleep "$INTERVAL"
  done
else
  transform_and_send
fi
