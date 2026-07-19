import type { McpGateway } from "./mcpGateway.js";

export class SnapshotQueryService {
  constructor(private readonly gateway: McpGateway) {}

  listTools(spaceId: string, snapshotId: string) {
    return this.gateway.toolDefinitionsForSnapshot(spaceId, snapshotId);
  }

  instructions(spaceId: string, snapshotId: string) {
    return this.gateway.instructionsForSnapshot(spaceId, snapshotId);
  }

  call(
    spaceId: string,
    snapshotId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    turnSessionId?: string
  ) {
    return this.gateway.callSnapshotTool(spaceId, snapshotId, toolName, args, signal, turnSessionId);
  }

  closeTurn(turnSessionId: string): Promise<void> {
    return this.gateway.closeSnapshotToolSession?.(turnSessionId) ?? Promise.resolve();
  }
}
