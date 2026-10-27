export function isBrowser() {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

export function isNode() {
  return typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null;
}

export function generateReqId() {
  return Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 10);
}

/** 简单深拷贝，只处理普通对象/数组/原始类型 */
export function shallowClone(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice();
  return Object.assign({}, obj);
}