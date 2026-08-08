// Web Push crypto, checked against RFC 8291's own published test vector.
//
// This is the one part of the push stack where a plausible-looking bug produces
// no error anywhere: an off-by-one info string still encrypts, still uploads,
// still gets a 201 from the push service, and then decrypts to garbage on the
// phone and shows nothing. A round-trip test against our own decryptor would pass
// just as happily. So the vector from RFC 8291 §5 is the test — same inputs, same
// ephemeral key, same salt, byte-identical output or we got it wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildPayload,
  encryptPayload,
  generateVapidKeys,
  isDeadSubscription,
  mintVapidJwt,
  parseSubscription,
  topicFor,
} from './webpush';

// ── RFC 8291 §5, verbatim ───────────────────────────────────────────────────

const VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const b = (s: string) => Buffer.from(s, 'base64url');
const expectedBody = b(VECTOR.body);
// The salt is simply the first 16 bytes of the encoding header — read it back out
// of the expected output rather than restating it, so the two can't drift.
const salt = expectedBody.subarray(0, 16);

test('encryptPayload reproduces the RFC 8291 §5 example byte for byte', () => {
  const out = encryptPayload(
    Buffer.from(VECTOR.plaintext, 'utf8'),
    b(VECTOR.uaPublic),
    b(VECTOR.authSecret),
    { asPrivate: b(VECTOR.asPrivate), salt },
  );
  assert.equal(out.toString('base64url'), VECTOR.body);
});

test('the aes128gcm header is salt(16) ‖ rs(4) ‖ idlen(1) ‖ key(65)', () => {
  const out = encryptPayload(
    Buffer.from(VECTOR.plaintext, 'utf8'),
    b(VECTOR.uaPublic),
    b(VECTOR.authSecret),
    { asPrivate: b(VECTOR.asPrivate), salt },
  );
  assert.deepEqual(out.subarray(0, 16), salt);
  assert.equal(out.readUInt32BE(16), 4096, 'record size');
  assert.equal(out.readUInt8(20), 65, 'key id length');
  // The keyid field is the ephemeral public key the receiver does ECDH against.
  assert.equal(out.subarray(21, 86).toString('base64url'), VECTOR.asPublic);
});

test('the ciphertext carries the 0x02 last-record delimiter (decrypts back)', () => {
  // Decrypt as the user agent would, deriving the keys independently from the
  // RECEIVER's private key. Proves the delimiter is inside the AEAD, not appended
  // after it — a mistake the vector comparison alone would also catch, but this
  // says which half is wrong when it fails.
  const out = encryptPayload(
    Buffer.from(VECTOR.plaintext, 'utf8'),
    b(VECTOR.uaPublic),
    b(VECTOR.authSecret),
    { asPrivate: b(VECTOR.asPrivate), salt },
  );
  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.setPrivateKey(b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'));
  const shared = uaEcdh.computeSecret(out.subarray(21, 86));

  const hmac = (k: Buffer, d: Buffer) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = hmac(b(VECTOR.authSecret), shared);
  const ikm = hmac(
    prkKey,
    Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      b(VECTOR.uaPublic),
      out.subarray(21, 86),
      Buffer.from([1]),
    ]),
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'utf8')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'utf8')).subarray(0, 12);

  const sealed = out.subarray(86);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);

  assert.equal(record[record.length - 1], 0x02, 'last-record delimiter');
  assert.equal(record.subarray(0, record.length - 1).toString('utf8'), VECTOR.plaintext);
});

test('a payload larger than one record is refused rather than truncated', () => {
  assert.throws(
    () =>
      encryptPayload(Buffer.alloc(4080), b(VECTOR.uaPublic), b(VECTOR.authSecret), {
        asPrivate: b(VECTOR.asPrivate),
        salt,
      }),
    /too large/,
  );
});

test('a fresh ephemeral key and salt are used per message', () => {
  const args = [Buffer.from('hi'), b(VECTOR.uaPublic), b(VECTOR.authSecret)] as const;
  const a = encryptPayload(...args);
  const c = encryptPayload(...args);
  // Reusing a (key, nonce) pair across two messages is a total AES-GCM break, so
  // this is a security property, not a style preference.
  assert.notEqual(a.toString('base64url'), c.toString('base64url'));
  assert.notDeepEqual(a.subarray(0, 16), c.subarray(0, 16), 'salt must differ');
  assert.notDeepEqual(a.subarray(21, 86), c.subarray(21, 86), 'ephemeral key must differ');
});

// ── VAPID (RFC 8292) ────────────────────────────────────────────────────────

const KEYS = generateVapidKeys();
const CFG = { ...KEYS, subject: 'mailto:ops@example.com' };

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('generateVapidKeys returns a 65-byte point and a 32-byte scalar', () => {
  assert.equal(Buffer.from(KEYS.publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(KEYS.publicKey, 'base64url')[0], 0x04, 'uncompressed point');
  assert.equal(Buffer.from(KEYS.privateKey, 'base64url').length, 32);
});

test('the VAPID JWT carries aud / exp / sub and an ES256 header', () => {
  const at = 1_800_000_000_000;
  const [h, p] = mintVapidJwt(CFG, 'https://web.push.apple.com', at).split('.');
  assert.deepEqual(decode(h), { typ: 'JWT', alg: 'ES256' });
  const claims = decode(p);
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, CFG.subject);
  // 12 h out, in seconds — RFC 8292 caps exp at 24 h from now.
  assert.equal(claims.exp, 1_800_000_000 + 12 * 3600);
});

test('the VAPID signature verifies as raw r||s, not DER', () => {
  const [h, p, s] = mintVapidJwt(CFG, 'https://web.push.apple.com').split('.');
  const pub = Buffer.from(CFG.publicKey, 'base64url');
  const key = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});

// ── payload shape, topic, misc ──────────────────────────────────────────────

test('the payload is Declarative Web Push and deep-links same-origin', () => {
  const body = JSON.parse(
    buildPayload(
      {
        title: 'agent-x',
        body: 'done',
        path: '/chat?session=abc',
        collapseKey: 'abc',
        kind: 'chat',
        urgent: false,
      },
      'https://dash.example.com',
    ).toString('utf8'),
  );
  // The marker is what lets iOS 18.4+ render this without running the SW.
  assert.equal(body.web_push, 8030);
  assert.equal(body.notification.title, 'agent-x');
  assert.equal(body.notification.navigate, 'https://dash.example.com/chat?session=abc');
  // tag = collapseKey is what keeps one session to one lock-screen slot.
  assert.equal(body.notification.tag, 'abc');
  assert.equal(body.notification.data.path, '/chat?session=abc');
});

test('Topic is stable, URL-safe and within RFC 8030 32 characters', () => {
  const long = 'cron-clh1234567890abcdefghijklmnopqrstuvwxyz';
  const t = topicFor(long);
  assert.equal(t, topicFor(long), 'same key → same topic');
  assert.ok(t.length <= 32, `${t.length} > 32`);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(t, topicFor('other'));
});

test('only 404 and 410 retire a subscription', () => {
  assert.equal(isDeadSubscription(404), true);
  assert.equal(isDeadSubscription(410), true);
  // Transient — deleting the row here would silently stop notifications until
  // the user happened to re-subscribe.
  for (const s of [201, 429, 500, 502, 503]) assert.equal(isDeadSubscription(s), false);
});

test('parseSubscription rejects anything not shaped like a PushSubscription', () => {
  const good = { endpoint: 'https://p.example/x', keys: { p256dh: 'a', auth: 'b' } };
  assert.deepEqual(parseSubscription(good), good);
  for (const bad of [null, undefined, 'x', {}, { endpoint: 'u' }, { endpoint: 'u', keys: { p256dh: 'a' } }]) {
    assert.equal(parseSubscription(bad), null);
  }
});
