/**
 * Dependency Injection Container
 * @classytic/revenue
 *
 * Lightweight DI container for managing dependencies
 * Inspired by: Awilix, InversifyJS but much simpler
 */

interface ServiceRegistration<T = unknown> {
  implementation: T | ((container: Container) => T);
  singleton: boolean;
  factory: boolean;
}

export class Container {
  private _services: Map<string, ServiceRegistration>;
  private _singletons: Map<string, unknown>;

  constructor() {
    this._services = new Map();
    this._singletons = new Map();
  }

  /**
   * Register a service
   * @param name - Service name
   * @param implementation - Service implementation or factory
   * @param options - Registration options
   */
  register<T>(
    name: string,
    implementation: T | ((container: Container) => T),
    options: { singleton?: boolean; factory?: boolean } = {}
  ): this {
    this._services.set(name, {
      implementation,
      singleton: options.singleton !== false, // Default to singleton
      factory: options.factory ?? false,
    });
    return this;
  }

  /**
   * Register a singleton service
   * @param name - Service name
   * @param implementation - Service implementation
   */
  singleton<T>(name: string, implementation: T): this {
    return this.register(name, implementation, { singleton: true });
  }

  /**
   * Register a transient service (new instance each time)
   * @param name - Service name
   * @param factory - Factory function
   */
  transient<T>(name: string, factory: (container: Container) => T): this {
    return this.register(name, factory, { singleton: false, factory: true });
  }

  /**
   * Get a service from the container
   * @param name - Service name
   * @returns Service instance
   */
  get<T>(name: string): T {
    // Check if already instantiated as singleton
    if (this._singletons.has(name)) {
      return this._singletons.get(name) as T;
    }

    const service = this._services.get(name);
    if (!service) {
      throw new Error(`Service "${name}" not registered in container`);
    }

    // Handle factory functions
    if (service.factory) {
      const factory = service.implementation as (container: Container) => T;
      const instance = factory(this);
      if (service.singleton) {
        this._singletons.set(name, instance);
      }
      return instance;
    }

    // Handle direct values
    const instance = service.implementation as T;
    if (service.singleton) {
      this._singletons.set(name, instance);
    }
    return instance;
  }

  /**
   * Check if service is registered
   * @param name - Service name
   */
  has(name: string): boolean {
    return this._services.has(name);
  }

  /**
   * Get all registered service names
   */
  keys(): string[] {
    return Array.from(this._services.keys());
  }

  /**
   * Clear all services (useful for testing)
   */
  clear(): void {
    this._services.clear();
    this._singletons.clear();
  }

  /**
   * Create a child container (for scoped dependencies)
   */
  createScope(): Container {
    const scope = new Container();
    // Copy parent services
    this._services.forEach((value, key) => {
      scope._services.set(key, value);
    });
    return scope;
  }
}

export default Container;

