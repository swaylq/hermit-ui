// APNs plumbing that can be checked without Apple: the provider-token format and
// the "no credentials configured" path.
//
// The JWT is the part most likely to be silently wrong — Node signs ECDSA as DER
// by default, JWS wants raw r||s, and APNs answers either mistake with the same
// unhelpful InvalidProviderToken. So sign with a throwaway P-256 key and verify
// the result the way a JWS consumer would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isConfigured, isDeadToken, mintAuthToken, sendApns } from './apns';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CFG = { keyP8: privateKey, keyId: 'ABCD123456', teamId: 'EFGH789012', bundleId: 'ai.swaylab.hermit' };

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('the provider token is a three-part JWS with the expected header', () => {
  const parts = mintAuthToken(CFG).split('.');
  assert.equal(parts.length, 3);
  assert.deepEqual(decode(parts[0]), { alg: 'ES256', kid: CFG.keyId });
});

test('claims carry the team id and a second-resolution iat', () => {
  const at = 1_800_000_000_123;
  const claims = decode(mintAuthToken(CFG, at).split('.')[1]);
  assert.equal(claims.iss, CFG.teamId);
  assert.equal(claims.iat, 1_800_000_000); // seconds, floored — not milliseconds
});

test('the signature verifies as raw r||s, not DER', () => {
  const [h, p, s] = mintAuthToken(CFG).split('.');
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  assert.equal(ok, true);
  // P-256 r||s is exactly 64 bytes; a DER signature would be ~70 and variable.
  assert.equal(Buffer.from(s, 'base64url').length, 64);
});

test('the token is base64url — no +, / or = to break a header', () => {
  assert.match(mintAuthToken(CFG), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('without APNS_* env the client reports unconfigured and sends nothing', async () => {
  const saved = { ...process.env };
  for (const k of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']) delete process.env[k];
  try {
    assert.equal(isConfigured(), false);
    // Must resolve, not hang or throw: push is never on a critical path.
    const r = await sendApns('deadbeef', 'sandbox', {
      title: 't',
      body: 'b',
      path: '/',
      collapseKey: 'k',
    });
    assert.deepEqual(r, { status: 0, reason: 'NotConfigured' });
  } finally {
    Object.assign(process.env, saved);
  }
});

test('isConfigured turns on once all four vars are present', () => {
  const saved = { ...process.env };
  try {
    process.env.APNS_KEY_P8 = privateKey;
    process.env.APNS_KEY_ID = CFG.keyId;
    process.env.APNS_TEAM_ID = CFG.teamId;
    assert.equal(isConfigured(), false, 'three of four is not configured');
    process.env.APNS_BUNDLE_ID = CFG.bundleId;
    assert.equal(isConfigured(), true);
  } finally {
    for (const k of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('a .p8 flattened into a single-line .env still parses', () => {
  const saved = { ...process.env };
  try {
    process.env.APNS_KEY_P8 = privateKey.replace(/\n/g, '\\n');
    process.env.APNS_KEY_ID = CFG.keyId;
    process.env.APNS_TEAM_ID = CFG.teamId;
    process.env.APNS_BUNDLE_ID = CFG.bundleId;
    assert.equal(isConfigured(), true);
  } finally {
    for (const k of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('only Apple-disowned tokens are treated as dead', () => {
  assert.equal(isDeadToken({ status: 410, reason: 'Unregistered' }), true);
  assert.equal(isDeadToken({ status: 400, reason: 'BadDeviceToken' }), true);
  assert.equal(isDeadToken({ status: 400, reason: 'DeviceTokenNotForTopic' }), true);
  // Transient / our-fault failures must NOT delete the device row.
  assert.equal(isDeadToken({ status: 429, reason: 'TooManyRequests' }), false);
  assert.equal(isDeadToken({ status: 500, reason: 'InternalServerError' }), false);
  assert.equal(isDeadToken({ status: 403, reason: 'ExpiredProviderToken' }), false);
  assert.equal(isDeadToken({ status: 0, reason: 'Timeout' }), false);
});
