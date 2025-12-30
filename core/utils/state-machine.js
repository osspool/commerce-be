export function createStateMachine(name, transitions = {}) {
  const normalized = new Map();

  Object.entries(transitions).forEach(([action, allowed]) => {
    const list = Array.isArray(allowed)
      ? allowed
      : Array.isArray(allowed?.from)
        ? allowed.from
        : [];
    normalized.set(action, new Set(list));
  });

  const can = (action, status) => {
    const allowed = normalized.get(action);
    if (!allowed || !status) return false;
    return allowed.has(status);
  };

  const assert = (action, status, errorFactory, message) => {
    if (can(action, status)) return;
    const errorMessage = message || `${name} cannot '${action}' when status is '${status || 'unknown'}'`;
    if (typeof errorFactory === 'function') {
      throw errorFactory(errorMessage);
    }
    throw new Error(errorMessage);
  };

  return {
    can,
    assert,
  };
}
