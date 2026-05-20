/**
 * GET /api/admin/tables — list registered admin tables (the editable
 * allowlist managed by lib/admin-tables.ts).
 *
 * Ported from app/api/admin/tables/route.ts. `auth: 'public'`.
 */
import { listAdminTables } from '@/lib/admin-tables';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'GET',
  path: '/admin/tables',
  auth: 'public',
  handler() {
    const out = listAdminTables().map((e) => {
      const cfg = getTableConfig(e.table as unknown as PgTable);
      return {
        exportName: e.exportName,
        label: e.label,
        schema: cfg.schema,
        name: cfg.name,
        editableColumns: e.editableColumns ?? null,
        allowDelete: e.allowDelete ?? true,
      };
    });
    return Response.json({ tables: out });
  },
});
