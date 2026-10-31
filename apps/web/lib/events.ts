export class Emitter<T extends unknown[]> {
  private fns = new Set<(...a: T) => void>();
  on(fn: (...a: T) => void) {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }
  emit(...a: T) {
    for (const f of this.fns) {
      try { f(...a); } catch (e) { console.error(e); }
    }
  }
}
