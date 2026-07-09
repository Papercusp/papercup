import { describe, it, expect, vi } from 'vitest';
import { fetchCurrentWeather, WeatherConfigError, WeatherFetchError } from './fetch-weather';

describe('fetchCurrentWeather', () => {
  it('throws WeatherConfigError when no api key is configured', async () => {
    await expect(fetchCurrentWeather({ lat: 40.7, lon: -74, apiKey: '' })).rejects.toThrow(WeatherConfigError);
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
