import { readFileSync } from 'node:fs';
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';
import { detectEmbeddedDatabaseSettings } from '@papercusp/resource-profile';
import postgres from 'postgres';

const pg = await startEmbeddedPostgresServer({
  dataDir: '/work/pgdata',
  credentialsFile: '/work/credentials.json',
  extraPostgresSettings: detectEmbeddedDatabaseSettings(),
});
try {
  const sql = postgres(pg.urls.admin, { max: 1 });
  try {
    const settings = await sql`
      SELECT name, CASE WHEN name = 'max_connections' THEN current_setting(name)::bigint
        ELSE pg_size_bytes(current_setting(name)) / 1048576 END AS value
      FROM unnest(ARRAY['max_connections', 'shared_buffers', 'effective_cache_size',
        'maintenance_work_mem', 'work_mem', 'wal_buffers', 'max_wal_size']) AS name
    `;
    const physicalCores = readFileSync('/proc/cpuinfo', 'utf8').match(/^processor\s*:/gm)?.length;
    const hostKiB = /^MemTotal:\s*(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1];
    console.log(JSON.stringify({ uid: process.getuid(), physicalCores, hostBytes: Number(hostKiB) * 1024,
      settings: Object.fromEntries(settings.map(row => [row.name, Number(row.value)])) }));
  } finally {
    await sql.end();
  }
} finally {
  await pg.stop();
}
