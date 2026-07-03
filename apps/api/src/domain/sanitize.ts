export function redactSensitive(value: string, sensitiveValues: string[]): string {
  return sensitiveValues.reduce((current, sensitiveValue) => {
    if (!sensitiveValue) {
      return current;
    }
    return current.split(sensitiveValue).join("[REDACTED]");
  }, value);
}
