/**
 * Carrier Registry — singleton.
 *
 * Owns the process-wide set of `CarrierAdapter` instances configured
 * from `config.logistics.providers`. Also constructs the composite
 * `AreaResolver` used by Pathao (static `@classytic/bd-areas/pathao`
 * first, live `PathaoLiveAreaResolver` as fallback).
 *
 * Lifecycle: lazy — adapters are built on first `get()`. Re-entrant
 * safe. No background work at import time.
 */
import { type CarrierAdapter, CarrierRegistry, CarrierRouter } from '@classytic/carrier';
import {
  type AreaResolver,
  createCompositeResolver,
  createPathaoLiveResolver,
  PathaoAdapter,
  RedXAdapter,
  SteadfastAdapter,
} from '@classytic/carrier-bd';
import config from '../../../config/index.js';

type CarrierCode = 'redx' | 'pathao' | 'steadfast';

class CarrierRegistryService {
  private built = false;
  private registry?: CarrierRegistry;
  private router?: CarrierRouter;
  private pathaoAdapter?: PathaoAdapter;
  private pathaoResolver?: AreaResolver;

  /** Build (once) and return the carrier registry. Safe to call repeatedly. */
  ensure(): CarrierRegistry {
    if (!this.built) this._build();
    return this.registry!;
  }

  /** Get a specific adapter by code. Throws if not configured. */
  get(code: CarrierCode): CarrierAdapter {
    const adapter = this.ensure().get(code) as CarrierAdapter | undefined;
    if (!adapter) {
      throw new Error(
        `Carrier '${code}' is not configured. Set its env vars (see config/sections/logistics.config.ts) and restart.`,
      );
    }
    return adapter;
  }

  /**
   * Return the default adapter (`config.logistics.defaultProvider`).
   * Falls back to the first configured adapter if the default is not
   * configured.
   */
  getDefault(): CarrierAdapter {
    const registry = this.ensure();
    const def = config.logistics.defaultProvider as CarrierCode;
    const adapter = (registry.get(def) as CarrierAdapter | undefined) ?? registry.all()[0];
    if (!adapter) {
      throw new Error('No carrier providers configured. Add at least one of REDX_*, PATHAO_*, STEADFAST_* to .env.');
    }
    return adapter;
  }

  /** Codes of the adapters that successfully initialised. */
  configured(): CarrierCode[] {
    return this.ensure().codes() as CarrierCode[];
  }

  router_(): CarrierRouter {
    if (!this.router) this._build();
    return this.router!;
  }

  /** Direct access to the PathaoAdapter — needed for live city/zone lookups. */
  pathao(): PathaoAdapter | undefined {
    this.ensure();
    return this.pathaoAdapter;
  }

  private _build(): void {
    const adapters: CarrierAdapter[] = [];
    const cfg = config.logistics;

    if (cfg.providers.redx) {
      adapters.push(
        new RedXAdapter({
          apiKey: cfg.providers.redx.apiKey,
          ...(cfg.providers.redx.apiUrl ? { apiUrl: cfg.providers.redx.apiUrl } : {}),
          ...(cfg.providers.redx.defaultPickupStoreId !== undefined
            ? { defaultPickupStoreId: cfg.providers.redx.defaultPickupStoreId }
            : {}),
        }),
      );
    }

    if (cfg.providers.pathao) {
      const pCfg = cfg.providers.pathao;
      this.pathaoAdapter = new PathaoAdapter({
        ...(pCfg.apiUrl ? { apiUrl: pCfg.apiUrl } : {}),
        credentials: {
          clientId: pCfg.clientId,
          clientSecret: pCfg.clientSecret,
          username: pCfg.username,
          password: pCfg.password,
        },
        ...(pCfg.defaultStoreCode !== undefined ? { defaultStoreCode: pCfg.defaultStoreCode } : {}),
      });
      // Wire the resolver AFTER construction so the live resolver can
      // reuse the same adapter's token cache + circuit breaker.
      this.pathaoResolver = createCompositeResolver([createPathaoLiveResolver(this.pathaoAdapter)]);
      // Re-create with the resolver attached. (PathaoAdapter accepts it
      // at construction; we couldn't pass it above because the resolver
      // needed the adapter reference.)
      this.pathaoAdapter = new PathaoAdapter({
        ...(pCfg.apiUrl ? { apiUrl: pCfg.apiUrl } : {}),
        credentials: {
          clientId: pCfg.clientId,
          clientSecret: pCfg.clientSecret,
          username: pCfg.username,
          password: pCfg.password,
        },
        ...(pCfg.defaultStoreCode !== undefined ? { defaultStoreCode: pCfg.defaultStoreCode } : {}),
        areaResolver: this.pathaoResolver,
      });
      adapters.push(this.pathaoAdapter);
    }

    if (cfg.providers.steadfast) {
      adapters.push(
        new SteadfastAdapter({
          apiKey: cfg.providers.steadfast.apiKey,
          apiSecret: cfg.providers.steadfast.apiSecret,
          ...(cfg.providers.steadfast.apiUrl ? { apiUrl: cfg.providers.steadfast.apiUrl } : {}),
        }),
      );
    }

    this.registry = new CarrierRegistry(adapters);
    this.router = new CarrierRouter({
      registry: this.registry,
      rules: adapters.map((a, i) => ({ carrier: a.code, priority: 100 - i })),
    });
    this.built = true;
  }
}

const carrierRegistry = new CarrierRegistryService();
export default carrierRegistry;
export type { CarrierCode };
