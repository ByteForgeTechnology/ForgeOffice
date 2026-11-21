// Build every web app bundle: one per web container, plus "all" for development
// and all-in-one installs. Usage: node build-apps.mjs [app ...]
import { execFileSync } from 'node:child_process';

const apps = process.argv.slice(2).length ? process.argv.slice(2) : ['all', 'portal', 'mail', 'calendar', 'contacts', 'tasks', 'admin'];
for (const app of apps) {
  console.log(`\n▶ building ${app}`);
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'], { stdio: 'inherit', env: { ...process.env, FORGE_WEB_APP: app } });
}
