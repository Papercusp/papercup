/**
 * Shared Ajv-resolver factory for forms whose schema is JSON Schema (the
 * per-plugin config editor; arbitrary plugin-author schemas).
 *
 * Wraps `@hookform/resolvers/ajv` with a pre-built Ajv instance that has
 * `ajv-formats` registered, so format keywords (`email`, `uri`, `uuid`,
 * `date-time`, etc.) resolve correctly without each call site re-registering.
 *
 * Usage (inside the plugin config editor):
 *
 *   import { useForm } from 'react-hook-form';
 *   import { makeAjvResolver } from './ajvResolver';
 *
 *   const resolver = useMemo(() => makeAjvResolver(plugin.configSchema), [plugin.configSchema]);
 *   const { register, handleSubmit, formState: { errors } } = useForm({
 *     resolver,
 *     defaultValues: loaded ?? {},
 *   });
 */
import { ajvResolver } from '@hookform/resolvers/ajv';
import { fullFormats } from 'ajv-formats/dist/formats';
import type { JSONSchemaType } from 'ajv';

export function makeAjvResolver<T = Record<string, unknown>>(schema: object) {
  // Cast: plugin schemas are loose JSON Schema, not JSONSchemaType<T>.
  // The resolver accepts the looser shape at runtime.
  return ajvResolver<T>(
    schema as JSONSchemaType<T>,
    {
      formats: fullFormats,
    },
    {
      mode: 'async',
    },
  );
}
