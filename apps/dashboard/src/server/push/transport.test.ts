// The dispatch seam: a device row's `platform` column picks its wire.
//
// The interesting cases are the boring ones. An unknown platform must not throw —
// it arrives from a DB column, so a rolled-back deploy or a hand-edited row would
// otherwise take down a /api/sync write. And Bark must count as configured with no
// env at all, because that is the entire point of it: push that works on a fresh
// server with nothing provisioned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anyTransportConfigured, configuredPlatforms, isPlatform, transportFor } from './transport';

test('each known platform resolves to its own transport', () => {
  for (const p of ['ios', 'web', 'bark'] as const) {
    assert.equal(transportFor(p)?.platform, p);
  }
});

test('an unrecognised platform resolves to null rather than throwing', () => {
  assert.equal(transportFor('android'), null);
  assert.equal(transportFor(''), null);
  assert.equal(isPlatform('android'), false);
});

test('Bark is configured with no environment at all, so push always works', () => {
  // Deliberately does NOT stub the env: on a bare server with no APNS_* and no
  // VAPID_*, this is what keeps enqueuePush from short-circuiting.
  assert.ok(configuredPlatforms().includes('bark'));
  assert.equal(anyTransportConfigured(), true);
});

test('web reports configured only with a complete VAPID triple', () => {
  const saved = {
    pub: process.env.VAPID_PUBLIC_KEY,
    priv: process.env.VAPID_PRIVATE_KEY,
    sub: process.env.VAPID_SUBJECT,
  };
  const restore = () => {
    for (const [k, v] of [
      ['VAPID_PUBLIC_KEY', saved.pub],
      ['VAPID_PRIVATE_KEY', saved.priv],
      ['VAPID_SUBJECT', saved.sub],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    assert.equal(configuredPlatforms().includes('web'), false);

    // Two of three is still unconfigured — a half-set keypair is the likeliest
    // real misconfiguration, and it must fail closed rather than at send time.
    process.env.VAPID_PUBLIC_KEY = 'x';
    process.env.VAPID_PRIVATE_KEY = 'y';
    assert.equal(configuredPlatforms().includes('web'), false);

    process.env.VAPID_SUBJECT = 'mailto:ops@example.com';
    assert.equal(configuredPlatforms().includes('web'), true);
  } finally {
    restore();
  }
});
