import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { fetchCurrentWeather, WeatherConfigError, WeatherFetchError } from './fetch-weather';

const REPO_LOCAL_OPERATOR_ENV = fileURLToPath(new URL('../../../../apps/operator/.env.local', import.meta.url));

describe('fetchCurrentWeather', () => {
  it('throws WeatherConfigError when no api key is configured', async () => {
    await expect(fetchCurrentWeather({ lat: 40.7, lon: -74, apiKey: '' })).rejects.toThrow(WeatherConfigError);
  });

  it('reads the host-only credential file when process env injection is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-weather-'));
    const apiKeyFile = join(dir, 'weatherapi-key');
    writeFileSync(apiKeyFile, 'file-key\n', { mode: 0o600 });
    vi.stubEnv('WEATHER_API_KEY', undefined as unknown as string);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 18 }, weather: [{ description: 'clear' }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    try {
      await expect(fetchCurrentWeather({ lat: 40.7, lon: -74, apiKeyFile, fetchImpl })).resolves.toMatchObject({
        tempC: 18,
        conditions: 'clear',
      });
      const calledUrl = String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(calledUrl).toContain('appid=file-key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it('keeps the vendor credential out of the repo-local operator env file', () => {
    let source: string;
    try {
      source = readFileSync(REPO_LOCAL_OPERATOR_ENV, 'utf8');
    } catch {
      // CI and fresh checkouts do not have the operator's ignored host env file.
      return;
    }
    const assignedKeys = source
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter((key): key is string => Boolean(key));
    expect(assignedKeys).not.toContain('WEATHER_API_KEY');
  });

  it('returns parsed weather on a successful vendor response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ main: { temp: 21.4 }, weather: [{ description: 'clear sky' }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await fetchCurrentWeather({ lat: 40.7, lon: -74, apiKey: 'k', fetchImpl });
    expect(result.tempC).toBe(21.4);
    expect(result.conditions).toBe('clear sky');
    expect(result.source).toBe('openweathermap');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toContain('appid=k');
    expect(calledUrl).toContain('lat=40.7');
  });

  it('throws WeatherFetchError on a non-ok vendor response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch;
    await expect(fetchCurrentWeather({ lat: 0, lon: 0, apiKey: 'bad', fetchImpl })).rejects.toThrow(WeatherFetchError);
  });

  it('throws WeatherFetchError when the response has no main.temp', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchCurrentWeather({ lat: 0, lon: 0, apiKey: 'k', fetchImpl })).rejects.toThrow(WeatherFetchError);
  });

  it('throws WeatherFetchError when the network call itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchCurrentWeather({ lat: 0, lon: 0, apiKey: 'k', fetchImpl })).rejects.toThrow(WeatherFetchError);
  });
});
