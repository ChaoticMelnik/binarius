// Work a route starts after its response and shutdown waits for (#874): the OAuth callback's
// Telegram push. A task must not reject; settle() waits whatever it does.
export interface InFlight {
  add(task: Promise<void>): void;
  // resolves once nothing is in flight, a task added during the wait included
  settle(): Promise<void>;
  readonly size: number;
}

export function createInFlight(): InFlight {
  const tasks = new Set<Promise<void>>();
  return {
    add(task) {
      tasks.add(task);
      void task.then(
        () => tasks.delete(task),
        () => tasks.delete(task),
      );
    },
    async settle() {
      while (tasks.size > 0) await Promise.allSettled([...tasks]);
    },
    get size() {
      return tasks.size;
    },
  };
}
