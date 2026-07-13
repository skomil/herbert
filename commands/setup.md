---
description: Enable Claude Code OTel telemetry export to the herbert dashboard
---

Configure Claude Code to emit OpenTelemetry metrics and logs to the local herbert server so the dashboard has data.

1. Read `~/.claude/settings.json` (create it as `{}` if missing).
2. Merge the following keys into its `env` object, preserving everything else in the file:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:16300",
    "OTEL_METRIC_EXPORT_INTERVAL": "10000",
    "OTEL_LOGS_EXPORT_INTERVAL": "5000"
  }
}
```

If the user has set a custom `HERBERT_PORT`, use that port in the endpoint instead of 16300.

3. Tell the user telemetry takes effect for **newly started** Claude Code sessions, and that the dashboard is at http://127.0.0.1:16300 (use the `dashboard_info` MCP tool to confirm the server is running).
