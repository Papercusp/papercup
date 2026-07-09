/**
 * fetch-weather — local weather for the operator dashboard
 * (platform-ops-batch-2026-07-09 P-003).
 *
 * Vendor: Open-Meteo-compatible current-weather endpoint keyed by
 * `WEATHER_API_KEY` (env-only — storage policy: this is a THIRD-PARTY vendor
 * credential, not one of the 4 platform provider keys `setup:save_key` owns,
 * so it lives in the gitignored `apps/operator/.env.local` an operator host
 * sources at boot, NEVER in a tracked file / NEVER hardcoded here). Reading
 * from `process.env` at call time (not module load) keeps this test-injectable
 * and avoids baking a missing-key crash into import order.
 */

export interface WeatherResult {
  tempC: number;
  conditions: string;
  fetchedAt: string;
  source: string;
}

export interface FetchWeatherOptions {
  lat: number;
  lon: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to process.env.WEATHER_API_KEY. */
  apiKey?: string;
}

export class WeatherConfigError extends Error {}
export class WeatherFetchError extends Error {}

/**
 * Fetch current local weather for (lat, lon). Throws WeatherConfigError when
 * no API key is configured (surfaced as a clear "not set up" state, not a
 * silent zero-data widget) and WeatherFetchError on a vendor/network failure.
 */
export async function fetchCurrentWeather(opts: FetchWeatherOptions): Promise<WeatherResult> {
  const apiKey = opts.apiKey ?? process.env.WEATHER_API_KEY;
  if (!apiKey) {
    throw new WeatherConfigError(
      'WEATHER_API_KEY is not configured — set it in apps/operator/.env.local (never commit it).',
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL('https://api.openweathermap.org/data/2.5/weather');
  url.searchParams.set('lat', String(opts.lat));
  url.searchParams.set('lon', String(opts.lon));
  url.searchParams.set('units', 'metric');
  url.searchParams.set('appid', apiKey);

  let res: Response;
  try {
    res = await doFetch(url.toString());
  } catch (e) {
    throw new WeatherFetchError(`weather vendor request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new WeatherFetchError(`weather vendor returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    main?: { temp?: number };
    weather?: Array<{ description?: string }>;
  };
  const tempC = body.main?.temp;
  if (typeof tempC !== 'number') {
    throw new WeatherFetchError('weather vendor response missing main.temp');
  }
  return {
    tempC,
    conditions: body.weather?.[0]?.description ?? 'unknown',
    fetchedAt: new Date().toISOString(),
    source: 'openweathermap',
  };
}
