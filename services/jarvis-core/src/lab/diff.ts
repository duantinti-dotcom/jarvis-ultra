/** Diff de linhas (LCS) em formato unificado simplificado. */
export function lineDiff(a: string, b: string): string {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length * B.length > 4_000_000) return `--- antes (${A.length} linhas)\n+++ depois (${B.length} linhas)\n(arquivos grandes demais para diff detalhado)`;
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push(`  ${A[i]}`); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(`- ${A[i++]}`);
    else out.push(`+ ${B[j++]}`);
  }
  while (i < A.length) out.push(`- ${A[i++]}`);
  while (j < B.length) out.push(`+ ${B[j++]}`);
  return out.join('\n');
}
