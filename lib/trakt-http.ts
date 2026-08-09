export class TraktHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function isTerminalTraktError(error: unknown) {
  return error instanceof TraktHttpError && (error.status === 401 || error.status === 403);
}
