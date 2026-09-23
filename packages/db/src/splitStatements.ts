/**
 * Splits a SQL script into individual statements on top-level semicolons.
 *
 * Neither postgres.js' extended protocol (used when parameters are passed)
 * nor PGlite's `query()` accept multiple commands in a single prepared
 * statement, so migration files (which may contain several `CREATE TABLE`
 * statements and free-form `--`/`/* *\/` comments) are split client-side
 * and executed one at a time. The splitter tracks single-quoted string
 * literals, `--` line comments and `/* *\/` block comments so semicolons
 * inside any of them (including in commentary prose) are not mistaken for
 * statement terminators. It does not handle dollar-quoted function bodies,
 * which this package's plain-DDL migrations do not use.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'") inSingleQuote = false;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }

  const rest = current.trim();
  if (rest.length > 0) statements.push(rest);
  return statements;
}
