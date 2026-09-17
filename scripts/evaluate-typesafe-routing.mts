import { readFile } from 'node:fs/promises';
import { TypeSafeIntentRouter, type CustomerIntent } from '../src/routing/typesafe-router.ts';

type Sample = { id: string; language: string; text: string; expected?: CustomerIntent; expectedAny?: CustomerIntent[]; expectHandoff?: boolean };
const samples = JSON.parse(await readFile(new URL('../src/routing/fixtures/customer-routing-labeled.json', import.meta.url), 'utf8')) as Sample[];
if (!process.env['TYPESAFE_API_KEY']) throw new Error('Set TYPESAFE_API_KEY in the server environment before running this evaluation.');

const router = new TypeSafeIntentRouter();
const rows = [];
for (const sample of samples) {
  const decision = await router.route(sample.text);
  const expected = sample.expectedAny ?? (sample.expected ? [sample.expected] : []);
  rows.push({
    id: sample.id,
    language: sample.language,
    expected: expected.join('|'),
    predicted: decision.intent,
    confidence: Number(decision.confidence.toFixed(3)),
    disposition: decision.disposition,
    labelCorrect: expected.includes(decision.intent),
    handoffExpected: sample.expectHandoff ?? sample.expected === 'complaint',
  });
}
console.table(rows);
const labelAccuracy = rows.filter((row) => row.labelCorrect).length / rows.length;
const expectedHandoffs = rows.filter((row) => row.handoffExpected);
const missedHandoffs = expectedHandoffs.filter((row) => row.disposition !== 'human_handoff');
console.log(JSON.stringify({ samples: rows.length, labelAccuracy, expectedHandoffs: expectedHandoffs.length, missedHandoffs: missedHandoffs.map((row) => row.id) }, null, 2));
process.exitCode = missedHandoffs.length === 0 ? 0 : 2;
