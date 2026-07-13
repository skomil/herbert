/**
 * Minimal parser for OTLP/HTTP JSON payloads as emitted by Claude Code
 * (OTEL_EXPORTER_OTLP_PROTOCOL=http/json). Normalizes metric data points
 * and log records (events) into flat records the store can aggregate.
 */
function attrValue(v) {
    if (!v)
        return undefined;
    if (typeof v.stringValue === 'string')
        return v.stringValue;
    if (v.intValue !== undefined)
        return String(v.intValue);
    if (v.doubleValue !== undefined)
        return String(v.doubleValue);
    if (v.boolValue !== undefined)
        return String(v.boolValue);
    return undefined;
}
function attrsToObject(list) {
    const out = {};
    for (const kv of list ?? []) {
        const val = attrValue(kv.value);
        if (typeof kv.key === 'string' && val !== undefined)
            out[kv.key] = val;
    }
    return out;
}
function nanoToMs(nano) {
    const n = Number(nano);
    return Number.isFinite(n) && n > 0 ? Math.round(n / 1e6) : Date.now();
}
const AGG_TEMPORALITY_DELTA = 1;
export function parseMetrics(payload) {
    const out = [];
    for (const rm of payload?.resourceMetrics ?? []) {
        const resAttrs = attrsToObject(rm.resource?.attributes);
        for (const sm of rm.scopeMetrics ?? []) {
            for (const m of sm.metrics ?? []) {
                const sum = m.sum;
                const gauge = m.gauge;
                const dataPoints = sum?.dataPoints ?? gauge?.dataPoints ?? [];
                const temporality = sum
                    ? sum.aggregationTemporality === AGG_TEMPORALITY_DELTA
                        ? 'delta'
                        : 'cumulative'
                    : 'gauge';
                for (const dp of dataPoints) {
                    const value = dp.asDouble ?? (dp.asInt !== undefined ? Number(dp.asInt) : NaN);
                    if (!Number.isFinite(value))
                        continue;
                    out.push({
                        kind: 'metric',
                        t: nanoToMs(dp.timeUnixNano),
                        start: dp.startTimeUnixNano !== undefined ? String(dp.startTimeUnixNano) : undefined,
                        name: String(m.name ?? ''),
                        value,
                        temporality,
                        attrs: { ...resAttrs, ...attrsToObject(dp.attributes) },
                    });
                }
            }
        }
    }
    return out;
}
export function parseLogs(payload) {
    const out = [];
    for (const rl of payload?.resourceLogs ?? []) {
        const resAttrs = attrsToObject(rl.resource?.attributes);
        for (const sl of rl.scopeLogs ?? []) {
            for (const lr of sl.logRecords ?? []) {
                const attrs = { ...resAttrs, ...attrsToObject(lr.attributes) };
                const body = attrValue(lr.body);
                // Claude Code events carry their name in `event.name` or the body.
                const name = attrs['event.name'] ?? body ?? 'unknown';
                out.push({
                    kind: 'event',
                    t: nanoToMs(lr.timeUnixNano ?? lr.observedTimeUnixNano),
                    name: name.replace(/^claude_code\./, ''),
                    body,
                    attrs,
                });
            }
        }
    }
    return out;
}
