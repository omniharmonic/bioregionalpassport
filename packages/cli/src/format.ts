import type { ProvisionStep, VerifyCheck } from '@passport/control-plane';

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const MARK: Record<string, string> = { created: '+', updated: '~', unchanged: '=' };

export function formatSteps(steps: ProvisionStep[]): string {
  return table(
    ['', 'step', 'status', 'detail'],
    steps.map((s) => [MARK[s.status] ?? ' ', s.name, s.status, s.detail ?? '']),
  );
}

export function formatChecks(checks: VerifyCheck[]): string {
  return table(
    ['', 'check', 'result', 'detail'],
    checks.map((c) => [c.skipped ? '-' : c.ok ? '✓' : '✗', c.name, c.skipped ? 'skipped' : c.ok ? 'ok' : 'FAILED', c.detail ?? '']),
  );
}

export function formatRows(headers: string[], rows: string[][]): string {
  return table(headers, rows);
}
