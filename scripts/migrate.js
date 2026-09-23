const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const migrationDir = path.join(rootDir, 'migrations');
const databaseUrl = process.env.DATABASE_URL;

function listMigrations() {
  if (!fs.existsSync(migrationDir)) {
    return [];
  }

  return fs.readdirSync(migrationDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

function main() {
  const migrations = listMigrations();

  if (process.env.NODE_ENV === 'production' && !databaseUrl) {
    console.error('DATABASE_URL is required for production migration.');
    process.exit(1);
  }

  if (!migrations.length) {
    console.log('No migration files found in migrations/.');
    return;
  }

  console.log('Migration files discovered:');
  migrations.forEach((file) => console.log(`- ${file}`));

  if (!databaseUrl) {
    console.log('DATABASE_URL is not configured. Running in dry-run mode only.');
    return;
  }

  console.log(`DATABASE_URL detected. Ready for PostgreSQL migration execution.`);
  console.log('This repository is prepared for a production database, but migration execution is intentionally protected to avoid accidental destructive actions.');
}

main();
