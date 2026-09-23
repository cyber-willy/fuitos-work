const fs = require('fs');
const path = require('path');

const migrationDir = path.join(__dirname, '..', 'migrations');

if (!fs.existsSync(migrationDir)) {
  console.log('No migrations directory found.');
  process.exit(0);
}

const files = fs.readdirSync(migrationDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (!files.length) {
  console.log('No migration files found.');
  process.exit(0);
}

console.log('Migration status:');
files.forEach((file) => console.log(`- ${file} ready`));
