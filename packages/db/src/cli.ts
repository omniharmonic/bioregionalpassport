#!/usr/bin/env node
import { createDb } from './adapters/postgres.js';
import { migratePlatform, migratePod } from './migrate.js';

function usage(): never {
  console.error('usage: passport-db migrate-platform | migrate-pod <slug>');
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const db = createDb(url);
  try {
    if (cmd === 'migrate-platform') {
      await migratePlatform(db);
      console.log('platform migrated');
    } else if (cmd === 'migrate-pod') {
      if (!arg) usage();
      await migratePod(db, arg);
      console.log(`pod '${arg}' migrated`);
    } else {
      usage();
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
