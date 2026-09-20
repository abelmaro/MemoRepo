const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

export function resolveApiUrl(configuredUrl: string | undefined, dashboardHostname: string): string {
  const apiUrl = configuredUrl ?? "http://127.0.0.1:8787";
  if (!LOCAL_HOSTNAMES.has(dashboardHostname)) {
    return apiUrl;
  }

  try {
    const url = new URL(apiUrl);
    if (!LOCAL_HOSTNAMES.has(url.hostname)) {
      return apiUrl;
    }

    url.hostname = dashboardHostname;
    return url.toString().replace(/\/$/, "");
  } catch {
    return apiUrl;
  }
}
