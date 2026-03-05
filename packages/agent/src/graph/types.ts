export interface GraphNodeRunArgs<TState, TContext> {
  state: TState;
  context: TContext;
  attempt: number;
}

export type GraphNodeRunResult = string | null | void;

export interface GraphNode<TState, TContext> {
  id: string;
  run(args: GraphNodeRunArgs<TState, TContext>): Promise<GraphNodeRunResult>;
}

export interface GraphRunnerHooks<TState, TContext> {
  onNodeStarted?(args: {
    nodeId: string;
    attempt: number;
    state: TState;
    context: TContext;
  }): Promise<void> | void;
  onNodeSucceeded?(args: {
    nodeId: string;
    attempt: number;
    state: TState;
    context: TContext;
  }): Promise<void> | void;
  onNodeFailed?(args: {
    nodeId: string;
    attempt: number;
    error: unknown;
    state: TState;
    context: TContext;
  }): Promise<void> | void;
}

export interface GraphRunnerInput<TState, TContext> {
  state: TState;
  context: TContext;
  startNode: string;
  nodes: Record<string, GraphNode<TState, TContext>>;
  resolveNext?: (args: {
    nodeId: string;
    state: TState;
    context: TContext;
  }) => string | null;
  failNode?: string;
  maxIterations?: number;
  hooks?: GraphRunnerHooks<TState, TContext>;
}

