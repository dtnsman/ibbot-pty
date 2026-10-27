export class EventBus {
  constructor() {
    this._map = new Map();
  }

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!this._map.has(event)) this._map.set(event, new Set());
    this._map.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const set = this._map.get(event);
    if (set) set.delete(fn);
  }

  emit(event, payload) {
    const set = this._map.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); }
      catch (e) { console.error(`[EventBus] listener error on "${event}":`, e); }
    }
  }

  removeAll(event) {
    if (event) this._map.delete(event);
    else this._map.clear();
  }
}