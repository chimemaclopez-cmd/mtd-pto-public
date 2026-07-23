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

async function kvSetJson(key, value) {
  const { result, error } = await command(['SET', key, JSON.stringify(value)]);
  if (error) throw new Error(`Upstash SET ${key} failed: ${error}`);
  return result;
}

module.exports = { isConfigured, kvGetJson, kvSetJson };
