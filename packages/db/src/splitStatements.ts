/**
 * Splits a SQL script into individual statements on top-level semicolons.
 *
 * Neither postgres.js' extended protocol (used when parameters are passed)
 * nor PGlite's `query()` accept multiple commands in a single prepared
 * statement, so migration files (which may contain several `CREATE TABLE`
 * statements and free-form `--`/`/* *\/` comments) are split client-side
 * and executed one at a time. The splitter tracks single-quoted string
 * literals, `--` line comments, `/* *\/` block comments, and
 * dollar-quoted bodies (`$$...$$` / `$tag$...$tag$`, e.g. function bodies)
 * so semicolons inside any of them are not mistaken for statement
 * terminators. Everything between a dollar-quote's opening and matching
 * closing delimiter is treated as opaque — nested quotes, comments and
 * semicolons within it have no effect on splitting, matching how Postgres
 * itself treats dollar-quoted string content.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch;
      i++;
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'") inSingleQuote = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  const rest = current.trim();
  if (rest.length > 0) statements.push(rest);
  return statements;
}
