export function requestOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const configured = process.env.SHELFCHECK_PUBLIC_URL?.trim();
  if (!configured) return requestUrl.origin;
  try {
    const publicUrl = new URL(configured);
    return publicUrl.protocol === "http:" || publicUrl.protocol === "https:" ? publicUrl.origin : requestUrl.origin;
  } catch {
    return requestUrl.origin;
  }
}
