// Local development: the Node API server and the Vite dev server together.
// The Knack REST key is NOT read from .env (it must never be in a file); pass
// it on the command line:  KNACK_API_KEY=... npm run dev
import { spawn } from 'node:child_process';

if (!process.env.KNACK_API_KEY) {
  console.error('Set KNACK_API_KEY for this shell, e.g.  KNACK_API_KEY=… npm run dev');
  process.exit(1);
}
const run = (name, cmd, args, extraEnv = {}) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const tag = (line) => `${name.padEnd(4)} │ ${line}`;
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(tag(l))));
  child.on('exit', (code) => {
    console.log(tag(`exited (${code})`));
    process.exit(code ?? 0);
  });
  return child;
};
const api = run('api', 'node', ['--env-file-if-exists=.env', 'packages/server-node/dist/main.js']);
const web = run('web', 'npm', ['run', 'dev', '-w', '@headless/web']);
process.on('SIGINT', () => {
  api.kill();
  web.kill();
});
