/**
 * What of an unexpected error goes in the log: its type, message, code and
 * stack, plus a database error's code, constraint and table. Never the
 * database's "detail" text, which can contain the values involved
 * (e.g. "Key (email)=(someone@example.com) already exists").
 */
export function errorForLog(err: unknown) {
  if (!(err instanceof Error)) return { message: String(err) };
  const e = err as Error & { code?: unknown; constraint?: unknown; table?: unknown; cause?: unknown };
  const cause = e.cause as { code?: unknown; constraint?: unknown; table?: unknown; message?: unknown } | undefined;
  return {
    type: e.name,
    message: e.message,
    code: e.code ?? cause?.code,
    constraint: e.constraint ?? cause?.constraint,
    table: e.table ?? cause?.table,
    stack: e.stack,
  };
}
