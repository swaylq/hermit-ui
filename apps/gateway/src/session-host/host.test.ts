// The host with a fake child (`cat`, which lives as long as its stdin is open).
//
// No Claude Code here on purpose: what these check is the part that has nothing
// to do with Claude — that a client detaching leaves the child alone, that the
// next client adopts it rather than starting a second one, and that the bound
// on children nobody is attached to actually fires. The real-CLI half is in
// runtime/session-host.itest.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSessionHost, type SessionHost } from './host';
import { HOST_PROTOCOL_VERSION, type AttachResponse, type ListResponse } from './protocol';

function tmpSock(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-')), 'io.sock');
}

/** Connect, send one line, resolve with the first line back. */
function ask<T>(sock: string, body: unknown, keepOpen = false): Promise<{ res: T; conn: net.Socket }> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    let out = '';
    conn.on('connect', () => conn.write(`${JSON.stringify(body)}\n`));
    conn.on('data', (d) => {
      out += d.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      const res = JSON.parse(out.slice(0, nl)) as T;
      if (!keepOpen) conn.destroy();
      resolve({ res, conn });
    });
    conn.on('error', reject);
  });
}

const attach = (sessionId: string) => ({
  v: HOST_PROTOCOL_VERSION,
  op: 'attach' as const,
  sessionId,
  // `cat` holds stdin open forever, which is the property that matters: it
  // stands in for a CLI that is alive and waiting for input.
  bin: '/bin/cat',
  argv: [],
  cwd: os.tmpdir(),
  env: { PATH: process.env.PATH ?? '' },
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a client detaching leaves the child running, and the next client adopts it', async () => {
  const sock = tmpSock();
  let host!: SessionHost;
  try {
    host = await startSessionHost({ socketPath: sock, log: () => {}, sweepMs: 3_600_000 });

    const first = await ask<AttachResponse>(sock, attach('s1'), true);
    assert.equal(first.res.ok, true);
    assert.equal(first.res.spawned, true);
    const pid = first.res.pid;
    assert.ok(alive(pid));

    // The gateway dies.
    first.conn.destroy();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(pid), 'the child died with its client — the whole point is that it does not');

    const second = await ask<AttachResponse>(sock, attach('s1'), true);
    assert.equal(second.res.spawned, false, 'the second client started a new child instead of adopting');
    assert.equal(second.res.pid, pid);
    second.conn.destroy();
  } finally {
    await host?.close();
  }
});

test('a child nobody attaches to is not left running forever', async () => {
  const sock = tmpSock();
  let host!: SessionHost;
  try {
    host = await startSessionHost({ socketPath: sock, log: () => {}, idleKillMs: 300, sweepMs: 100 });
    const { res, conn } = await ask<AttachResponse>(sock, attach('s2'), true);
    const pid = res.pid;
    conn.destroy();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && alive(pid)) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false, 'an unattached child outlived its idle bound');

    const list = await ask<ListResponse>(sock, { v: HOST_PROTOCOL_VERSION, op: 'list' });
    assert.deepEqual(list.res.sessions, []);
  } finally {
    await host?.close();
  }
});

test('a request the host cannot read is refused rather than half-served', async () => {
  const sock = tmpSock();
  let host!: SessionHost;
  try {
    host = await startSessionHost({ socketPath: sock, log: () => {}, sweepMs: 3_600_000 });
    // A future gateway talking a protocol this host does not know must be told
    // so, not silently handed a session it cannot drive.
    const { res } = await ask<{ ok: boolean; error?: string }>(sock, { ...attach('s3'), v: 99 });
    assert.equal(res.ok, false);
    assert.match(res.error!, /protocol v1/);
    const list = await ask<ListResponse>(sock, { v: HOST_PROTOCOL_VERSION, op: 'list' });
    assert.deepEqual(list.res.sessions, [], 'a refused request still spawned something');
  } finally {
    await host?.close();
  }
});
