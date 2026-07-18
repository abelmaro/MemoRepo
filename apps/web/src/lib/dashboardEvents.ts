import { useEffect } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { subscribeToDashboardEvents, type DashboardEvent, type DashboardResource } from "./api";

export function useDashboardEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const reconcile = () => void queryClient.invalidateQueries({ refetchType: "active" });
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const unsubscribe = subscribeToDashboardEvents((event) => handleDashboardEvent(queryClient, event));
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      unsubscribe();
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [queryClient]);
}

export function handleDashboardEvent(queryClient: QueryClient, event: DashboardEvent): void {
  if (event.type === "ready") {
    void queryClient.invalidateQueries({ refetchType: "active" });
    return;
  }
  const seen = new Set<string>();
  for (const key of event.resources.flatMap(queryKeysForResource)) {
    const serialized = JSON.stringify(key);
    if (seen.has(serialized)) continue;
    seen.add(serialized);
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function queryKeysForResource(resource: DashboardResource): QueryKey[] {
  switch (resource.type) {
    case "spaces": return [["spaces"], ["space"]];
    case "space": return resource.spaceId ? [["space", resource.spaceId], ["spaces"]] : [["space"], ["spaces"]];
    case "jobs": return [["jobs"]];
    case "job": return resource.jobId ? [["job", resource.jobId], ["jobs"]] : [["job"], ["jobs"]];
    case "snapshots": return resource.spaceId
      ? [["space-snapshots", resource.spaceId], ["space", resource.spaceId]]
      : [["space-snapshots"], ["space"]];
    case "connections": return resource.spaceId
      ? [["mcp-connections", resource.spaceId], ["space", resource.spaceId]]
      : [["mcp-connections"], ["space"]];
    case "maintenance": return [["maintenance-summary"]];
    case "system": return [["system"], ["github-auth-status"], ["github-diagnostics"]];
    case "preflight": return [["preflight"]];
    case "agent": {
      const keys: QueryKey[] = [["agent", "status"]];
      keys.push(resource.spaceId ? ["agent", "chats", resource.spaceId] : ["agent", "chats"]);
      // Queue position is global. A turn starting, completing, or being cancelled can
      // shift the selected turn even when the event originated in another chat.
      keys.push(["agent", "chat"]);
      if (resource.spaceId && resource.chatId) keys.push(["agent", "chat", resource.spaceId, resource.chatId]);
      return keys;
    }
    default: return [];
  }
}
