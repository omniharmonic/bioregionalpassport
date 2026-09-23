import { describe, expect, it } from 'vitest';
import { splitStatements } from './splitStatements.js';

describe('splitStatements', () => {
  it('splits plain statements on top-level semicolons', () => {
    const sql = 'CREATE TABLE a(id int);\nCREATE TABLE b(id int);';
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a(id int)', 'CREATE TABLE b(id int)']);
  });

  it('ignores semicolons inside single-quoted strings', () => {
    const sql = "INSERT INTO t (v) VALUES ('a;b');\nSELECT 1;";
    expect(splitStatements(sql)).toEqual(["INSERT INTO t (v) VALUES ('a;b')", 'SELECT 1']);
  });

  it('ignores semicolons inside line and block comments', () => {
    const sql = '-- comment; with a semicolon\nCREATE TABLE a(id int);\n/* block; comment */\nCREATE TABLE b(id int);';
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE a(id int)');
    expect(statements[1]).toContain('CREATE TABLE b(id int)');
  });

  it('treats a $$-quoted function body with embedded semicolons, quotes and comments as one statement', () => {
    const sql = `
CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
BEGIN
  -- a comment; with a semicolon
  INSERT INTO t (v) VALUES ('a;b'); /* another; comment */
  RAISE NOTICE 'done;';
END;
$$ LANGUAGE plpgsql;
CREATE TABLE after_fn(id int);
`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE OR REPLACE FUNCTION f()');
    expect(statements[0]).toContain("RAISE NOTICE 'done;';");
    expect(statements[0].trim().endsWith('$$ LANGUAGE plpgsql')).toBe(true);
    expect(statements[1].trim()).toBe('CREATE TABLE after_fn(id int)');
  });

  it('supports a tagged dollar-quote delimiter (e.g. $fn$)', () => {
    const sql = `
CREATE OR REPLACE FUNCTION g() RETURNS void AS $fn$
BEGIN
  PERFORM 1; -- semicolon inside tagged body
END;
$fn$ LANGUAGE plpgsql;
CREATE TABLE after_g(id int);
`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('$fn$');
    expect(statements[0].trim().endsWith('$fn$ LANGUAGE plpgsql')).toBe(true);
    expect(statements[1].trim()).toBe('CREATE TABLE after_g(id int)');
  });

  it('does not treat a positional parameter like $1 as a dollar-quote', () => {
    const sql = 'SELECT $1, $2 WHERE id = $1;\nSELECT 2;';
    expect(splitStatements(sql)).toEqual(['SELECT $1, $2 WHERE id = $1', 'SELECT 2']);
  });
});
