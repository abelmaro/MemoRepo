const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function normalizedRequestPathname(url: string): string | null {
  try {
    const encodedPathname = new URL(url, "http://localhost").pathname;
    const decodedPathname = decodeURIComponent(encodedPathname).replaceAll("\\", "/");
    return CONTROL_CHARACTERS.test(decodedPathname) ? null : decodedPathname;
  } catch {
    return null;
  }
}
