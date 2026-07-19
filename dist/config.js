import os from 'node:os';
import path from 'node:path';
/** Port the shared herbert server listens on (dashboard + OTLP receiver + REST API). */
export const DEFAULT_PORT = 16300;
export const VERSION = '0.3.1';
/** Hard cap on spec/correction/retro summaries, per product requirement. */
export const MAX_SUMMARY_CHARS = 599;
export function port() {
    const p = Number(process.env.HERBERT_PORT);
    return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT;
}
/** Bind address. Override with HERBERT_HOST=0.0.0.0 to accept a proxy on another interface. */
export function host() {
    return process.env.HERBERT_HOST || '127.0.0.1';
}
export function dataDir() {
    return process.env.HERBERT_DATA_DIR || path.join(os.homedir(), '.claude', 'herbert');
}
/** Loopback URL clients use to reach the server, regardless of bind address. */
export function baseUrl(p = port()) {
    return `http://127.0.0.1:${p}`;
}
