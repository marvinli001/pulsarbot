export interface LoopJobDefinition {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
  immediate?: boolean;
}

interface LoopJobState {
  definition: LoopJobDefinition;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  running: boolean;
}

export class IndependentJobRunner {
  private readonly jobs = new Map<string, LoopJobState>();
  private started = false;

  public register(definition: LoopJobDefinition) {
    if (this.jobs.has(definition.name)) {
      throw new Error(`Loop job is already registered: ${definition.name}`);
    }
    this.jobs.set(definition.name, {
      definition,
      timer: null,
      stopped: false,
      running: false,
    });
    if (this.started) {
      this.schedule(definition.name, definition.immediate === false ? definition.intervalMs : 0);
    }
  }

  public start() {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const [name, job] of this.jobs) {
      this.schedule(name, job.definition.immediate === false ? job.definition.intervalMs : 0);
    }
  }

  public stop() {
    this.started = false;
    for (const job of this.jobs.values()) {
      job.stopped = true;
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
  }

  private schedule(name: string, delayMs: number) {
    const job = this.jobs.get(name);
    if (!job || job.stopped) {
      return;
    }
    if (job.timer) {
      clearTimeout(job.timer);
    }
    job.timer = setTimeout(() => {
      job.timer = null;
      void this.execute(name);
    }, Math.max(0, delayMs));
  }

  private async execute(name: string) {
    const job = this.jobs.get(name);
    if (!job || job.stopped) {
      return;
    }
    if (job.running) {
      this.schedule(name, job.definition.intervalMs);
      return;
    }

    job.running = true;
    try {
      await job.definition.run();
    } catch (error) {
      job.definition.onError?.(error);
    } finally {
      job.running = false;
      if (!job.stopped) {
        this.schedule(name, job.definition.intervalMs);
      }
    }
  }
}
