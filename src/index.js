import { spawn } from 'child_process';

if (!process.execArgv.some(a => a.includes('--expose-gc'))) {
  const child = spawn(process.execPath, ['--expose-gc', '--optimize-for-size', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + signal : 0)));
  child.on('error', (err) => { console.error(err); process.exit(1); });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  await new Promise(() => {});
}

const { BotController } = await import('./botController.js');
const { config } = await import('./config.js');
const { createServer, listen } = await import('./server.js');
const { StatsStore } = await import('./stats.js');
const { WordSolver } = await import('./wordSolver.js');

const stats = new StatsStore();
const solver = new WordSolver(config.wordsPath);
const botController = new BotController({ solver, stats });
const server = createServer({ stats, botController });

stats.recordLog('info', `Loaded ${solver.anagrams.size} anagram signatures`, config.wordsPath);
listen(server);

if (process.env.AUTO_JOIN === 'true') {
  botController.join();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  botController.leave('Process shutting down');
  server.close(() => process.exit(0));
}
