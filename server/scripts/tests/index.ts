import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, uniquePlayerId, Client } from './lib/client.js';
import { runTest, printSummary, TestResult } from './lib/runner.js';
import * as econ from './economyTests.js';
import * as sec from './securityTests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..', '..'); // scripts/tests -> scripts -> server

const RUN_ID = Date.now().toString(36);

function makeTestClient(tag: string): Client {
  return makeClient(uniquePlayerId(tag, RUN_ID));
}

async function main() {
  const baseUrl = process.env.TEST_SERVER_URL ?? 'http://localhost:8787';
  console.log(`Прогон автотестов #${RUN_ID} против ${baseUrl}`);
  console.log(
    'ВНИМАНИЕ: эти тесты двигают рынок и создают/пополняют тестовых dev_-игроков на этом сервере. Запускать ТОЛЬКО против локального dev-сервера (npm run dev), никогда против продакшена на Render.'
  );

  const results: TestResult[] = [];

  // Execution order is deliberately NOT 1..12: tests 1-3 share one long
  // POST /debug/fast-forward run that deliberately blasts the shared market
  // state (every coin's price/pool) tens of simulated hours into the
  // future — since all tests hit the SAME running server/EngineState, that
  // would leave every other test operating against an already wildly
  // drifted market if it ran first. So the market-nuking run goes LAST;
  // everything else runs first against comparatively fresh state. The
  // summary below re-sorts back into numeric order for readability.

  // Tests 4-5 share one player/position: 5 sells back what 4 bought, then
  // restores the coin's pool so the pair is non-destructive overall.
  let t4Fixture: {
    coinId: string;
    client: Client;
    originalPool: { coinReserve: number; usddReserve: number; playerOwnedCoins: number } | null;
  } | null = null;
  results.push(
    await runTest('4. Захват эмиссии крупным покупателем', async () => {
      const r = await econ.test4_emissionCapture(RUN_ID, makeTestClient);
      t4Fixture = { coinId: r.coinId, client: r.client, originalPool: r.originalPool };
      return r.outcome;
    })
  );
  results.push(
    await runTest('5. Продажа крупной позиции обратно', async () => {
      if (!t4Fixture) return { pass: false, lines: ['ПРОПУЩЕН: тест 4 не выполнился успешно, нечего продавать.'] };
      return econ.test5_sellBackSlippage(t4Fixture.client, t4Fixture.coinId, t4Fixture.originalPool);
    })
  );

  const marketClient = makeTestClient('market');
  results.push(await runTest('6. Новости — плавность движения', () => econ.test6_newsSmoothness(marketClient)));
  results.push(await runTest('7. Слайдер 100% под движущейся ценой', () => econ.test7_fullSliderUnderMovement(makeTestClient)));

  results.push(await runTest('8. Дебаг-эндпоинты заблокированы в проде', () => sec.test8_debugEndpointsBlockedInProd(SERVER_DIR)));
  results.push(await runTest('9. Мгновенный памп + мгновенный клейм ранга', () => sec.test9_instantPumpRankClaim(makeTestClient)));
  results.push(await runTest('10. Повторный клейм эмиссии на разных монетах', () => sec.test10_emissionDoubleClaim(makeTestClient)));
  results.push(await runTest('11. Заявка на сумму больше баланса через API', () => sec.test11_overBalanceTrade(makeTestClient)));
  results.push(await runTest('12. Гонка одновременных сделок', () => sec.test12_concurrentTrades(makeTestClient)));

  console.log('\nПодготовка теста 1-3: прогоняем рынок вперёд без единой сделки (может занять до минуты)...');
  const { ff, coins } = await econ.runMarketSimulation(marketClient);
  results.push(await runTest('1. Рынок без единого игрока за несколько макроциклов', async () => econ.test1_marketWithoutPlayer(ff, coins)));
  results.push(await runTest('2. Просадка/рост топ-монеты по фазам', async () => econ.test2_bullBearSwing(ff)));
  results.push(await runTest('3. "Зима" не сносит цену системно', async () => econ.test3_winterNeutral(ff)));

  const bySpecOrder = [...results].sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10));
  printSummary(bySpecOrder);
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
}

main().catch(err => {
  console.error('Тестовый скрипт упал с необработанной ошибкой:', err);
  process.exitCode = 1;
});
