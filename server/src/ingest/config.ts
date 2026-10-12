// Only the administrator's deployed Apps Script URL is embedded in installers.
export function validIngestUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "script.google.com" && !url.username && !url.password
      && !url.port && !url.search && !url.hash && /^\/macros\/s\/[\w-]{20,200}\/exec$/.test(url.pathname);
  } catch { return false; }
}
