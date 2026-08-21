'use strict';
/*
  Minimal Upstash Redis REST client (no npm dependencies, Node 18+ built-ins only).
  Used to share PTO request/audit/settings data (and read-only roster/schedule/
  attendance snapshots) between the local admin server and the public PTO server.

  Configure via env vars:
    UPSTASH_REDIS_REST_URL
    UPSTASH_REDIS_REST_TOKEN
  If either is missing, isConfigured() returns false and callers should fall
  back to their own local storage.
*/
const https = require('https');
const http = require('http');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function isConfigured() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

function command(args) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) return reject(new Error('Upstash is not configured (missing UPSTASH_REDIS_REST_URL/TOKEN).'));
    let target;
    try { target = new URL(UPSTASH_URL); } catch (error) { return reject(new Error(`Invalid UPSTASH_REDIS_REST_URL: ${error.message}`)); }
    const body = JSON.stringify(args);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: '/',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Upstash HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (error) { reject(new Error(`Upstash returned invalid JSON: ${error.message}`)); }
      });
    });
    // Without this, a request that hangs mid-flight during a network blip (DNS drop,
    // connection reset) never resolves or rejects - it just leaks. Since callers fire
    // this every ~30s on a timer, leaked requests pile up silently and the whole sync
    // loop can look "stuck" even after the network recovers (confirmed live: signal
    // publishing froze for 15+ minutes after a burst of ECONNRESET/ENOTFOUND errors).
    req.setTimeout(10000, () => req.destroy(new Error('Upstash request timed out after 10s')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function kvGetJson(key, fallback) {
  const { result, error } = await command(['GET', key]);
  if (error) throw new Error(`Upstash GET ${key} failed: ${error}`);
  if (result == null) return fallback;
  try { return JSON.parse(result); } catch { return fallback; }
}

async function kvSetJson(key, value, { exSeconds } = {}) {
  const args = ['SET', key, JSON.stringify(value)];
  if (exSeconds) args.push('EX', String(exSeconds));
  const { result, error } = await command(args);
  if (error) throw new Error(`Upstash SET ${key} failed: ${error}`);
  return result;
}

async function kvDel(key) {
  const { result, error } = await command(['DEL', key]);
  if (error) throw new Error(`Upstash DEL ${key} failed: ${error}`);
  return result;
}

// Atomic set add - unlike a GET-modify-SET on a JSON blob, this can't lose a concurrent
// writer's member if two calls land close together (used for alert-sent dedup memory,
// where losing a member means the same alert can go out twice).
async function kvSadd(key, member) {
  const { result, error } = await command(['SADD', key, member]);
  if (error) throw new Error(`Upstash SADD ${key} failed: ${error}`);
  return result;
}

async function kvSmembers(key) {
  const { result, error } = await command(['SMEMBERS', key]);
  if (error) throw new Error(`Upstash SMEMBERS ${key} failed: ${error}`);
  return result || [];
}

async function kvExpire(key, seconds) {
  const { result, error } = await command(['EXPIRE', key, String(seconds)]);
  if (error) throw new Error(`Upstash EXPIRE ${key} failed: ${error}`);
  return result;
}

module.exports = { isConfigured, kvGetJson, kvSetJson, kvDel, kvSadd, kvSmembers, kvExpire };
