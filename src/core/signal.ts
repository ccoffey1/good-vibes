/** A typed, dependency-free event: `subscribe` returns a disposable, `fire` notifies listeners. */
export class Signal<T = void> {
  private readonly listeners = new Set<(value: T) => void>();

  subscribe = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}
