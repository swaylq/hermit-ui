// What the purge is allowed to delete off the upload disk.
//
// This module ends in `rm -rf`, on a directory whose name comes from an id the
// caller supplies. Everything worth testing here is therefore about the cases
// where that id is NOT a session id: the whole upload root is one `..` away, and
// it holds file-station's in-flight transfers as well as every other session's
// images. So the tests below are mostly refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'hermit-uploads-'));
  const prev = process.env.HERMIT_UPLOAD_DIR;
  process.env.HERMIT_UPLOAD_DIR = root;
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) delete process.env.HERMIT_UPLOAD_DIR;
    else process.env.HERMIT_UPLOAD_DIR = prev;
  }
}

const SID = 'cmpkuxzi7002bpv497bd0pc0n'; // shape of a real cuid

async function seed(root: string, id: string, bytes = 1024) {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, 'a.png'), Buffer.alloc(bytes));
  await writeFile(join(root, id, 'a.safe.png'), Buffer.alloc(bytes));
}

test('deletes exactly the session it was given', async () => {
  await withRoot(async (root) => {
    const { deleteSessionUploads } = await import('./session-uploads');
    await seed(root, SID);
    await seed(root, 'cmppsnjsq007hpvnspobdjk55');
    await mkdir(join(root, 'file-station'), { recursive: true });

    const r = await deleteSessionUploads([SID]);
    assert.equal(r.dirs, 1);
    assert.equal(r.bytes, 2048);
    const left = (await readdir(root)).sort();
    assert.deepEqual(left, ['cmppsnjsq007hpvnspobdjk55', 'file-station']);
  });
});

test('a session that never uploaded anything is not an error', async () => {
  await withRoot(async (root) => {
    const { deleteSessionUploads } = await import('./session-uploads');
    await mkdir(root, { recursive: true });
    const r = await deleteSessionUploads([SID]);
    assert.deepEqual(r, { dirs: 0, bytes: 0 });
  });
});

// The point of the whole file: none of these may reach the root, and none may
// throw — a purge that already dropped the DB row must not be retried forever.
test('refuses anything that is not a session id', async () => {
  await withRoot(async (root) => {
    const { deleteSessionUploads } = await import('./session-uploads');
    await seed(root, SID);
    await mkdir(join(root, 'file-station'), { recursive: true });
    await writeFile(join(root, 'file-station', 'x.bin'), Buffer.alloc(8));

    const r = await deleteSessionUploads(['', '.', '..', '../..', '/', 'file-station', `../${SID}`, 'a'.repeat(200)]);
    assert.deepEqual(r, { dirs: 0, bytes: 0 });
    assert.ok((await stat(root)).isDirectory());
    const left = (await readdir(root)).sort();
    assert.deepEqual(left, [SID, 'file-station']);
  });
});

test('sizes are read per session', async () => {
  await withRoot(async (root) => {
    const { sessionUploadBytes, sessionUploadBytesMany } = await import('./session-uploads');
    await seed(root, SID, 512);
    assert.equal(await sessionUploadBytes(SID), 1024);
    assert.equal(await sessionUploadBytes('cmppsnjsq007hpvnspobdjk55'), 0);
    const m = await sessionUploadBytesMany([SID, '..']);
    assert.equal(m.get(SID), 1024);
    assert.equal(m.get('..'), 0);
  });
});
