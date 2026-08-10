function firstForwardedValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() || "";
}

export function requestOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto")).toLowerCase();
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? `${forwardedProto}:`
    : requestUrl.protocol;

  if (!forwardedHost) return `${protocol}//${requestUrl.host}`;

  try {
    return new URL(`${protocol}//${forwardedHost}`).origin;
  } catch {
    return requestUrl.origin;
  }
}
