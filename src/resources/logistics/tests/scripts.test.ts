/**
 * Logistics Config Tests — be-prod side.
 *
 * The new contract: `config.logistics.providers` only contains entries
 * for carriers whose env vars are set. Empty providers object is valid.
 */
import { describe, expect, it } from 'vitest';
import config from '../../../config/index.js';

describe('Logistics Config', () => {
  it('exposes a logistics section with defaultProvider + providers', () => {
    expect(config.logistics).toBeDefined();
    expect(config.logistics.defaultProvider).toMatch(/^(redx|pathao|steadfast)$/);
    expect(config.logistics.providers).toBeDefined();
  });

  it('every present RedX config has apiKey + apiUrl + isSandbox flag', () => {
    const redx = config.logistics.providers.redx;
    if (!redx) return; // not configured in this env
    expect(typeof redx.apiKey).toBe('string');
    expect(redx.apiKey.length).toBeGreaterThan(0);
    expect(typeof redx.apiUrl).toBe('string');
    expect(typeof redx.isSandbox).toBe('boolean');
  });

  it('every present Pathao config has clientId/secret/username/password', () => {
    const pathao = config.logistics.providers.pathao;
    if (!pathao) return;
    expect(pathao.clientId.length).toBeGreaterThan(0);
    expect(pathao.clientSecret.length).toBeGreaterThan(0);
    expect(pathao.username.length).toBeGreaterThan(0);
    expect(pathao.password.length).toBeGreaterThan(0);
  });

  it('every present Steadfast config has apiKey + apiSecret', () => {
    const sf = config.logistics.providers.steadfast;
    if (!sf) return;
    expect(sf.apiKey.length).toBeGreaterThan(0);
    expect(sf.apiSecret.length).toBeGreaterThan(0);
  });
});
