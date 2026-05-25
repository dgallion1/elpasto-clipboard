#!/usr/bin/env bash
# coturn monitor — polls prometheus metrics and alerts via ntfy on spikes.
# Run via cron every 2 minutes:
#   */2 * * * * ~/elpasto/infra/coturn/monitor.sh
#
# Required env (or edit defaults below):
#   NTFY_TOPIC        — ntfy topic name (e.g. "my-coturn-alerts")
#   COTURN_METRICS_URL — prometheus endpoint (default: http://127.0.0.1:9641/metrics)

set -euo pipefail

METRICS_URL="${COTURN_METRICS_URL:-http://127.0.0.1:9641/metrics}"
NTFY_TOPIC="${NTFY_TOPIC:-my-coturn-alerts}"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}"
STATE_FILE="${STATE_DIR}/coturn-monitor-state"

# — Thresholds —
MAX_ACTIVE_ALLOCATIONS=20        # alert if active allocations exceed this
TRAFFIC_SPIKE_BYTES=$((50*1024*1024))  # 50 MB delta between checks = spike
MAX_TOTAL_ALLOCATIONS_PER_CHECK=30     # new allocations since last check

fetch_metric() {
  local name="$1"
  grep "^${name} " <<< "$METRICS" | awk '{print $2}' | head -1
}

send_alert() {
  local title="$1" body="$2" priority="${3:-high}"
  curl -s -o /dev/null \
    -H "Title: ${title}" \
    -H "Priority: ${priority}" \
    -H "Tags: warning,coturn" \
    -d "${body}" \
    "${NTFY_URL}"
}

# Fetch metrics; exit silently if coturn is down (separate uptime check).
METRICS=$(curl -sf --max-time 5 "${METRICS_URL}" 2>/dev/null) || exit 0

active=$(fetch_metric "turn_total_active_allocations" || echo 0)
total=$(fetch_metric "turn_total_allocations_created" || echo 0)
sent=$(fetch_metric "turn_total_traffic_sent_bytes" || echo 0)
rcvd=$(fetch_metric "turn_total_traffic_rcvd_bytes" || echo 0)

# Default to integers.
active=${active%%.*}
total=${total%%.*}
sent=${sent%%.*}
rcvd=${rcvd%%.*}

# Load previous state.
prev_total=0
prev_sent=0
prev_rcvd=0
if [[ -f "$STATE_FILE" ]]; then
  # Parse state without source to avoid code injection from a tampered file.
  while IFS='=' read -r key val; do
    case "$key" in
      prev_total) prev_total="${val//[!0-9]/}" ;;
      prev_sent)  prev_sent="${val//[!0-9]/}" ;;
      prev_rcvd)  prev_rcvd="${val//[!0-9]/}" ;;
    esac
  done < "$STATE_FILE"
fi

# Save current state for next run.
cat > "$STATE_FILE" <<EOF
prev_total=${total}
prev_sent=${sent}
prev_rcvd=${rcvd}
EOF

# — Check active allocations —
if (( active > MAX_ACTIVE_ALLOCATIONS )); then
  send_alert "coturn: high allocations" \
    "${active} active allocations (threshold: ${MAX_ACTIVE_ALLOCATIONS})" \
    "urgent"
fi

# — Check allocation rate —
new_allocs=$(( total - prev_total ))
if (( new_allocs > MAX_TOTAL_ALLOCATIONS_PER_CHECK )); then
  send_alert "coturn: allocation spike" \
    "${new_allocs} new allocations since last check (threshold: ${MAX_TOTAL_ALLOCATIONS_PER_CHECK})"
fi

# — Check traffic spike —
delta_sent=$(( sent - prev_sent ))
delta_rcvd=$(( rcvd - prev_rcvd ))
delta_total=$(( delta_sent + delta_rcvd ))

if (( delta_total > TRAFFIC_SPIKE_BYTES )); then
  mb=$(( delta_total / 1024 / 1024 ))
  send_alert "coturn: traffic spike" \
    "${mb} MB relayed since last check (threshold: $(( TRAFFIC_SPIKE_BYTES / 1024 / 1024 )) MB)"
fi

# — Periodic summary (every ~30 min, i.e. every 15th run) —
run_count=0
if [[ -f "${STATE_FILE}.runs" ]]; then
  raw=$(cat "${STATE_FILE}.runs")
  run_count="${raw//[!0-9]/}"
  run_count="${run_count:-0}"
fi
run_count=$(( run_count + 1 ))
echo "$run_count" > "${STATE_FILE}.runs"

if (( run_count % 15 == 0 )); then
  total_mb=$(( (sent + rcvd) / 1024 / 1024 ))
  send_alert "coturn: status" \
    "Active: ${active} | Total allocs: ${total} | Traffic: ${total_mb} MB cumulative" \
    "low"
fi
