'use strict';
/*
  Minimal SendGrid email client (no npm dependencies, Node built-ins only).
  Used to notify a rep's Reports To (and a fixed CC) when a CSAT dispute is filed.

  Configure via env vars:
    SENDGRID_API_KEY    - required to actually send; if missing, send() rejects
    SENDGRID_FROM_EMAIL - the address verified as a Single Sender in SendGrid
*/
const https = require('https');

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'mac@lofty.com';
const FROM_NAME = 'Lofty Support Portal';

function isConfigured() {
  return Boolean(SENDGRID_API_KEY);
}

function send({ to, cc = [], subject, html }) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) return reject(new Error('SendGrid is not configured (missing SENDGRID_API_KEY).'));
    if (!to) return reject(new Error('An email recipient is required.'));
    const toList = (Array.isArray(to) ? to : [to]).filter(Boolean).map(email => ({ email }));
    const ccList = (Array.isArray(cc) ? cc : [cc]).filter(Boolean).map(email => ({ email }));
    if (!toList.length) return reject(new Error('An email recipient is required.'));
    const personalization = { to: toList };
    if (ccList.length) personalization.cc = ccList;
    const body = JSON.stringify({
      personalizations: [personalization],
      from: { email: SENDGRID_FROM_EMAIL, name: FROM_NAME },
      subject: String(subject || '(no subject)'),
      content: [{ type: 'text/html', value: String(html || '') }]
    });
    const req = https.request({
      hostname: 'api.sendgrid.com',
      port: 443,
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(true);
        reject(new Error(`SendGrid HTTP ${res.statusCode}: ${data.slice(0, 400)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { isConfigured, send };
