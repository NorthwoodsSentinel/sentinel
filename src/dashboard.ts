// Sentinel Dashboard — served directly from the Worker
// No build step, no React, no framework. Pure HTML + fetch + CSS.
// This is the demo piece for Cloudflare engineers and the Moser pitch.

export function renderDashboard(clientId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sentinel — ${clientId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      background: #0a0e17;
      color: #c8d6e5;
      min-height: 100vh;
    }
    .header {
      padding: 24px 32px;
      border-bottom: 1px solid #1a2332;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 {
      font-size: 20px;
      color: #00d4aa;
      font-weight: 600;
      letter-spacing: 2px;
    }
    .header .status {
      font-size: 13px;
      color: #576574;
    }
    .header .status .live {
      color: #00d4aa;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 16px;
      padding: 24px 32px;
    }
    .stat-card {
      background: #111927;
      border: 1px solid #1a2332;
      border-radius: 8px;
      padding: 20px;
    }
    .stat-card .label {
      font-size: 11px;
      color: #576574;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .stat-card .value {
      font-size: 32px;
      font-weight: 700;
      color: #fff;
    }
    .stat-card .value.green { color: #00d4aa; }
    .stat-card .value.yellow { color: #ffc048; }
    .stat-card .value.red { color: #ff6b6b; }
    .stat-card .sub {
      font-size: 11px;
      color: #576574;
      margin-top: 4px;
    }
    .section {
      padding: 0 32px 24px;
    }
    .section h2 {
      font-size: 14px;
      color: #576574;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid #1a2332;
    }
    .anomaly-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .anomaly {
      background: #111927;
      border: 1px solid #1a2332;
      border-radius: 8px;
      padding: 16px 20px;
      border-left: 4px solid #576574;
    }
    .anomaly.critical { border-left-color: #ff6b6b; }
    .anomaly.high { border-left-color: #ff9f43; }
    .anomaly.medium { border-left-color: #ffc048; }
    .anomaly.low { border-left-color: #576574; }
    .anomaly .meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .anomaly .severity {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      padding: 2px 8px;
      border-radius: 3px;
    }
    .anomaly.critical .severity { background: #ff6b6b22; color: #ff6b6b; }
    .anomaly.high .severity { background: #ff9f4322; color: #ff9f43; }
    .anomaly.medium .severity { background: #ffc04822; color: #ffc048; }
    .anomaly.low .severity { background: #57657422; color: #8395a7; }
    .anomaly .metric {
      font-size: 13px;
      color: #c8d6e5;
      margin-bottom: 4px;
    }
    .anomaly .stats {
      font-size: 12px;
      color: #576574;
    }
    .anomaly .narrative {
      font-size: 13px;
      color: #8395a7;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #1a2332;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .anomaly .time {
      font-size: 11px;
      color: #576574;
    }
    .baseline-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
    }
    .baseline-card {
      background: #111927;
      border: 1px solid #1a2332;
      border-radius: 8px;
      padding: 14px 18px;
    }
    .baseline-card .metric-name {
      font-size: 12px;
      color: #00d4aa;
      margin-bottom: 6px;
    }
    .baseline-card .stats-row {
      font-size: 12px;
      color: #576574;
      display: flex;
      justify-content: space-between;
    }
    .baseline-card .stats-row span { color: #8395a7; }
    .footer {
      padding: 24px 32px;
      border-top: 1px solid #1a2332;
      text-align: center;
      font-size: 11px;
      color: #576574;
    }
    .footer a { color: #00d4aa; text-decoration: none; }
  </style>
</head>
<body>
  <div class="header">
    <h1>SENTINEL</h1>
    <div class="status">
      <span class="live">&#9679;</span> LIVE &mdash; <span id="client-id">${clientId}</span>
      &mdash; <span id="last-update">loading...</span>
    </div>
  </div>

  <div class="grid" id="stats">
    <div class="stat-card"><div class="label">Events Ingested</div><div class="value" id="total-events">--</div><div class="sub">since deployment</div></div>
    <div class="stat-card"><div class="label">Anomalies Detected</div><div class="value yellow" id="total-anomalies">--</div><div class="sub">all time</div></div>
    <div class="stat-card"><div class="label">Baseline Status</div><div class="value green" id="baseline-status">--</div><div class="sub" id="baseline-sub"></div></div>
    <div class="stat-card"><div class="label">Last Ingestion</div><div class="value" id="last-ingestion" style="font-size:18px">--</div><div class="sub">ago</div></div>
  </div>

  <div class="section">
    <h2>Recent Anomalies</h2>
    <div class="anomaly-list" id="anomalies">
      <div class="anomaly"><div class="metric">Loading...</div></div>
    </div>
  </div>

  <div class="section">
    <h2>Baselines</h2>
    <div class="baseline-grid" id="baselines">
      <div class="baseline-card"><div class="metric-name">Loading...</div></div>
    </div>
  </div>

  <div class="footer">
    SENTINEL v0.1.0 &mdash; Edge-native network intelligence &mdash;
    <a href="https://northwoodssentinel.com">Northwoods Sentinel Labs</a>
  </div>

  <script>
    const CLIENT = '${clientId}';
    const BASE = '';

    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return sec + 's ago';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + 'm ago';
      const hr = Math.floor(min / 60);
      return hr + 'h ' + (min % 60) + 'm ago';
    }

    function severityClass(s) {
      return (s || 'low').toLowerCase();
    }

    async function refresh() {
      try {
        const [statusRes, anomaliesRes, baselinesRes] = await Promise.all([
          fetch(BASE + '/status?client=' + CLIENT),
          fetch(BASE + '/anomalies?client=' + CLIENT + '&limit=15'),
          fetch(BASE + '/baselines?client=' + CLIENT)
        ]);

        const status = await statusRes.json();
        const anomalies = await anomaliesRes.json();
        const baselines = await baselinesRes.json();

        // Stats
        document.getElementById('total-events').textContent = status.total_events_ingested.toLocaleString();
        document.getElementById('total-anomalies').textContent = status.total_anomalies_detected;
        document.getElementById('baseline-status').textContent = status.baseline_ready ? 'READY' : 'LEARNING';
        document.getElementById('baseline-sub').textContent = status.baseline_ready ? 'Anomaly detection active' : 'Collecting baseline data...';
        document.getElementById('last-ingestion').textContent = status.last_ingestion ? timeAgo(status.last_ingestion) : 'never';
        document.getElementById('last-update').textContent = new Date().toLocaleTimeString();

        if (status.total_anomalies_detected > 10) {
          document.getElementById('total-anomalies').className = 'value red';
        }

        // Anomalies
        const anomalyHtml = anomalies.map(a => {
          const sev = severityClass(a.severity);
          const narrative = a.narrative ? '<div class="narrative">' + escapeHtml(a.narrative).replace(/\\n/g, '<br>').replace(/##\\s*/g, '') + '</div>' : '';
          return '<div class="anomaly ' + sev + '">' +
            '<div class="meta"><span class="severity">' + (a.severity || 'unknown').toUpperCase() + '</span><span class="time">' + timeAgo(a.detected_at) + '</span></div>' +
            '<div class="metric">' + escapeHtml(a.source) + ' : ' + escapeHtml(a.metric) + '</div>' +
            '<div class="stats">Expected: ' + (a.expected || 0).toFixed(1) + ' &mdash; Actual: ' + (a.actual || 0) + ' &mdash; Z-score: ' + (a.z_score || 0).toFixed(1) + '&sigma;</div>' +
            narrative +
            '</div>';
        }).join('');
        document.getElementById('anomalies').innerHTML = anomalyHtml || '<div class="anomaly"><div class="metric">No anomalies detected yet</div></div>';

        // Baselines
        const baselineHtml = baselines.map(b => {
          return '<div class="baseline-card">' +
            '<div class="metric-name">' + escapeHtml(b.source) + ' : ' + escapeHtml(b.metric) + '</div>' +
            '<div class="stats-row">Mean: <span>' + b.mean.toFixed(2) + '</span></div>' +
            '<div class="stats-row">Std Dev: <span>' + b.stddev.toFixed(2) + '</span></div>' +
            '<div class="stats-row">Samples: <span>' + b.count + '</span></div>' +
            '<div class="stats-row">Range: <span>' + b.min + ' &ndash; ' + b.max + '</span></div>' +
            '</div>';
        }).join('');
        document.getElementById('baselines').innerHTML = baselineHtml || '<div class="baseline-card"><div class="metric-name">No baselines yet</div></div>';

      } catch (err) {
        console.error('Refresh failed:', err);
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    refresh();
    setInterval(refresh, 15000);
  </script>
</body>
</html>`;
}
