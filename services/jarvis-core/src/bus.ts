import { EventEmitter } from 'node:events';
import type { CoreEvent } from '@jarvis/contracts';

class CoreBus extends EventEmitter {
  emitEvent(e: CoreEvent) {
    this.emit('event', e);
  }
  onEvent(fn: (e: CoreEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export type Bus = CoreBus;
export const createBus = () => {
  const b = new CoreBus();
  b.setMaxListeners(100);
  return b;
};
