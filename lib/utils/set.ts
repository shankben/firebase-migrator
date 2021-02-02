export function setIntersect<T>(x: Set<T>, y: Set<T>): Set<T> {
  const a = x.size <= y.size ? x : y;
  const b = a == x ? y : x;
  return new Set(Array.from(a).filter((it) => b.has(it)));
}
