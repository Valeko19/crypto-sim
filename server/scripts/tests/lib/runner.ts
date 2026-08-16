export interface TestOutcome {
  pass: boolean;
  // Concrete measured numbers/observations — always printed, pass or fail,
  // per the requirement that every test show what actually happened, not
  // just a checkmark.
  lines: string[];
  // Set when the implementation had to simplify or reinterpret something
  // from the spec (a technical limitation, an ambiguous threshold, an
  // extension beyond the literal example given) — printed distinctly so a
  // reader can tell "this deviates from the brief" apart from a normal
  // measured result.
  note?: string;
}

export interface TestResult extends TestOutcome {
  name: string;
  error?: string;
  durationMs: number;
}

export async function runTest(name: string, fn: () => Promise<TestOutcome>): Promise<TestResult> {
  console.log(`\n=== ${name} ===`);
  const start = Date.now();
  try {
    const outcome = await fn();
    const durationMs = Date.now() - start;
    for (const line of outcome.lines) console.log('  ' + line);
    if (outcome.note) console.log(`  [УПРОЩЕНИЕ/ОТКЛОНЕНИЕ ОТ ТЗ] ${outcome.note}`);
    console.log(`  РЕЗУЛЬТАТ: ${outcome.pass ? 'PASS' : 'FAIL'}  (${(durationMs / 1000).toFixed(1)}с)`);
    return { name, ...outcome, durationMs };
  } catch (e: any) {
    const durationMs = Date.now() - start;
    const message = e?.message ?? String(e);
    console.log(`  ИСКЛЮЧЕНИЕ: ${message}`);
    console.log(`  РЕЗУЛЬТАТ: FAIL  (${(durationMs / 1000).toFixed(1)}с)`);
    return { name, pass: false, lines: [], error: message, durationMs };
  }
}

export function printSummary(results: TestResult[]): void {
  const passed = results.filter(r => r.pass).length;
  console.log('\n' + '='.repeat(70));
  console.log(`ИТОГО: ${passed}/${results.length} тестов пройдено`);
  console.log('='.repeat(70));
  for (const r of results) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  }
  const failed = results.filter(r => !r.pass);
  if (failed.length > 0) {
    console.log('\nЧто именно пошло не так у проваленных тестов:');
    for (const r of failed) {
      console.log(`\n- ${r.name}`);
      if (r.error) console.log(`    исключение: ${r.error}`);
      for (const line of r.lines) console.log(`    ${line}`);
    }
  }
  console.log('');
}
