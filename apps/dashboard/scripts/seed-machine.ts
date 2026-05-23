#!/usr/bin/env node
// Seed the local machine. Prints the plaintext access key once — store it.
// Re-running rotates the key for the same machine name.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient();

async function main() {
  const NAME = process.argv[2] || 'mac-local';
  const HOSTNAME = os.hostname();

  const plaintext = crypto.randomBytes(24).toString('base64url'); // ~32 chars
  const keyPrefix = plaintext.slice(0, 8);
  const keyHash = await bcrypt.hash(plaintext, 12);

  const machine = await prisma.machine.upsert({
    where: { name: NAME },
    create: { name: NAME, hostname: HOSTNAME, keyHash, keyPrefix },
    update: { keyHash, keyPrefix, hostname: HOSTNAME },
  });

  console.log(`\nmachine ${machine.id} (${NAME}, hostname=${HOSTNAME})`);
  console.log(`\nX-Asst-Key=${plaintext}\n`);
  console.log('Store this. Lost keys cannot be recovered (only re-seeded).\n');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
