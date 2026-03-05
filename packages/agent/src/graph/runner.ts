import type { GraphRunnerInput } from "./types.js";

export class GraphNodeExecutionError extends Error {
  public readonly nodeId: string;

  public constructor(nodeId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Graph node "${nodeId}" failed: ${message}`);
    this.name = "GraphNodeExecutionError";
    this.nodeId = nodeId;
  }
}

export async function runGraph<TState, TContext>(
  input: GraphRunnerInput<TState, TContext>,
): Promise<{ state: TState; lastNode: string | null }> {
  const attempts = new Map<string, number>();
  const maxIterations = input.maxIterations ?? 128;
  let currentNode: string | null = input.startNode;
  let iterations = 0;

  while (currentNode) {
    const nodeId: string = currentNode;
    iterations += 1;
    if (iterations > maxIterations) {
      throw new Error(`Graph exceeded max iterations (${maxIterations})`);
    }

    const node: GraphRunnerInput<TState, TContext>["nodes"][string] | undefined =
      input.nodes[nodeId];
    if (!node) {
      throw new Error(`Graph node is not registered: ${nodeId}`);
    }

    const attempt = (attempts.get(nodeId) ?? 0) + 1;
    attempts.set(nodeId, attempt);

    await input.hooks?.onNodeStarted?.({
      nodeId,
      attempt,
      state: input.state,
      context: input.context,
    });

    try {
      const explicitNext: string | null | void = await node.run({
        state: input.state,
        context: input.context,
        attempt,
      });

      await input.hooks?.onNodeSucceeded?.({
        nodeId,
        attempt,
        state: input.state,
        context: input.context,
      });

      currentNode = typeof explicitNext !== "undefined"
        ? explicitNext
        : input.resolveNext?.({
            nodeId,
            state: input.state,
            context: input.context,
          }) ?? null;
    } catch (error) {
      await input.hooks?.onNodeFailed?.({
        nodeId,
        attempt,
        error,
        state: input.state,
        context: input.context,
      });

      if (input.failNode && nodeId !== input.failNode) {
        currentNode = input.failNode;
        continue;
      }

      throw new GraphNodeExecutionError(nodeId, error);
    }
  }

  return {
    state: input.state,
    lastNode: null,
  };
}
