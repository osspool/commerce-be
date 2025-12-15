
class LRUCache {
    constructor(maxSize = 100) {
      this.maxSize = maxSize;
      this.cache = new Map();
    }
  
    get(key) {
      if (this.cache.has(key)) {
        // Move to end (most recently used)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
      }
      return null;
    }
  
    set(key, value) {
      // Remove oldest if at capacity
      if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      // Add to end
      this.cache.set(key, value);
    }
  }

  export default LRUCache;