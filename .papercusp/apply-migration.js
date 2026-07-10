const fs = require('fs');
const path = require('path');
const postgres = require('postgres');

async function applyMigration(filePath, migrationName) {
  const sql = postgres({
    host: process.env.PG_HOST || 'localhost',
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DATABASE || 'papercusp',
    username: process.env.PG_USER || 'harness_admin',
    password: process.env.PG_PASSWORD || 'harness_admin_pwd',
  });

  try {
    const migrationContent = fs.readFileSync(filePath, 'utf8');
    const crypto = require('crypto');
    const sha256 = crypto.createHash('sha256').update(migrationContent).digest('hex');
    
    console.log(`Applying migration: ${migrationName}`);
    console.log(`SHA256: ${sha256}`);
    
    // Apply the migration file
    await sql.unsafe(migrationContent);
    
    // Record in schema_migrations
    await sql`
      INSERT INTO harness_shared.schema_migrations (filename, sha256)
      VALUES (${migrationName}, ${sha256})
      ON CONFLICT (filename) DO NOTHING
    `;
    
    console.log(`✓ Migration applied: ${migrationName}`);
    return true;
  } catch (err) {
    console.error(`✗ Migration failed: ${err.message}`);
    return false;
  } finally {
    await sql.end();
  }
}

const migrationFile = process.argv[2];
const migrationName = path.basename(migrationFile);
applyMigration(migrationFile, migrationName).then(ok => process.exit(ok ? 0 : 1));
