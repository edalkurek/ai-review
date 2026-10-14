/** Prevents overlapping timer executions without suppressing failures from the active run. */
export class SerialTaskGate {
  private running = false;

  public async tryRun(task: () => Promise<void>): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await task();
      return true;
    } finally {
      this.running = false;
    }
  }
}
