#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { program } = require('commander');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const inquirer = require('inquirer');
const ROOT = __dirname;
const PID_FILE = path.join(ROOT, 'proxy.pid');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CONFIG = { port: parseInt(process.env.PROXY_PORT || '8080'), host: 'http://127.0.0.1' };

function api(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `${CONFIG.host}:${CONFIG.port}`);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = http.request(url, { method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, data }); } });
    });
    req.on('error', e => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

function pid() { try { return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim()); } catch { return null; } }

function isRunning() {
  const p = pid();
  if (!p) return false;
  try {
    const out = execSync(`tasklist /FI "PID eq ${p}" /FO CSV /NH`, { encoding: 'utf-8', timeout: 3000 });
    return out.includes(String(p)) && !out.includes('No tasks');
  } catch { return false; }
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bright: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
function color(s, code) { return `${code}${s}${C.reset}`; }

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return { providers: {}, mappings: {}, default: '' }; }
}
function writeConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

function banner() {
  console.log(`\n${color('  ╔══════════════════════════════════════════╗', C.cyan)}`);
  console.log(`${color('  ║     Claude Spoof Proxy  —  CLI Portal    ║', C.cyan)}`);
  console.log(`${color('  ╚══════════════════════════════════════════╝', C.cyan)}\n`);
}

program.name('csp').description('Claude Spoof Proxy CLI Portal').version('1.0.0');

// ── start ──
function killPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf-8', timeout: 3000 });
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const p = parts[parts.length - 1];
      if (p && p.match(/^\d+$/)) { try { execSync(`taskkill /PID ${p} /F`, { stdio: 'ignore', timeout: 3000 }); } catch {} }
    }
  } catch {}
}

program.command('start')
  .description('Start the proxy server')
  .option('--fg', 'Run in foreground')
  .option('-f, --force', 'Kill anything on the port first')
  .action(async (opts) => {
    banner();
    if (opts.force) { killPort(CONFIG.port); try { fs.unlinkSync(PID_FILE); } catch {} await new Promise(r => setTimeout(r, 1000)); }
    const pExisting = pid();
    if (pExisting && isRunning()) return console.log(color('  ✗ Proxy is already running (PID: ' + pExisting + ')', C.yellow));
    if (opts.fg) { console.log(color('  Starting in foreground...\n', C.green)); require('./server.js'); return; }
    const out = fs.openSync(path.join(ROOT, 'proxy.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { detached: true, stdio: ['ignore', out, out], env: { ...process.env } });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(color('  ✓ Proxy started (PID: ' + child.pid + ')', C.green));
    await new Promise(r => setTimeout(r, 2000));
    if (isRunning()) console.log(color('  ✓ Running on http://127.0.0.1:' + CONFIG.port, C.green));
    else console.log(color('  ✗ Failed to start (check proxy.log)', C.red));
  });

// ── stop ──
program.command('stop').description('Stop the proxy server').action(() => {
  banner();
  const p = pid();
  if (p && isRunning()) {
    try { execSync(`taskkill /PID ${p} /F`, { stdio: 'ignore', timeout: 5000 }); console.log(color('  ✓ Proxy stopped (PID: ' + p + ')', C.green)); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }
  // Fallback: kill whatever is on the port
  killPort(CONFIG.port);
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log(color('  ✓ Port ' + CONFIG.port + ' cleared', C.green));
});

// ── restart ──
program.command('restart').description('Restart the proxy server').action(async () => {
  banner();
  killPort(CONFIG.port);
  try { fs.unlinkSync(PID_FILE); } catch {}
  await new Promise(r => setTimeout(r, 1500));
  const out = fs.openSync(path.join(ROOT, 'proxy.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { detached: true, stdio: ['ignore', out, out], env: { ...process.env } });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  await new Promise(r => setTimeout(r, 2000));
  if (isRunning()) console.log(color('  ✓ Proxy restarted (PID: ' + child.pid + ')', C.green));
  else console.log(color('  ✗ Failed to start (check proxy.log)', C.red));
});

// ── status ──
program.command('status').description('Show proxy status, providers & stats').action(async () => {
  banner();
  const p = pid();
  const running = p && isRunning();
  if (!running) return void console.log(color('  ● Proxy status: STOPPED', C.red));
  console.log(color('  ● Proxy status: RUNNING', C.green));
  console.log(color('    PID: ' + p, C.dim));
  try {
    const s = await api('/admin/stats');
    if (s.status === 200) {
      const d = s.data;
      console.log(color('    Uptime: ' + Math.floor(d.uptime / 60) + 'm ' + (d.uptime % 60) + 's', C.dim));
      console.log(color('    Requests: ' + d.requests + '  Errors: ' + d.errors, C.bright));
      console.log(color('    Providers: ' + (d.providers || []).join(', '), C.cyan));
      console.log(color('    Default: ' + (d.defaultTarget || '(none)'), C.dim));
      console.log('');
      if (Object.keys(d.byModel).length) {
        console.log(color('  Requests by model:', C.cyan));
        for (const [m, c] of Object.entries(d.byModel)) console.log(color(`    ${m.padEnd(35)} ${'█'.repeat(Math.min(c, 15))} ${c}`, C.dim));
      }
      if (Object.keys(d.byProvider).length) {
        console.log(color('  Requests by provider:', C.cyan));
        for (const [m, c] of Object.entries(d.byProvider)) console.log(color(`    ${m.padEnd(25)} ${c}`, C.dim));
      }
    }
  } catch (e) { console.log(color('    (stats unavailable: ' + e.message + ')', C.yellow)); }
});

// ── providers ──
program.command('providers')
  .description('List configured providers')
  .action(() => {
    banner();
    const cfg = readConfig();
    const entries = Object.entries(cfg.providers || {});
    if (!entries.length) return console.log(color('  (no providers configured)', C.dim));
    console.log(color('  Providers:', C.bright));
    console.log('');
    for (const [name, prov] of entries) {
      const keyMasked = (prov.apiKey || '').slice(0, 8) + '...';
      console.log(color(`  ${name.padEnd(18)}`, C.cyan) + color(prov.baseUrl, C.dim) + color('  [' + keyMasked + ']', C.yellow));
    }
    console.log('');
  });

// ── provider add ──
program.command('provider-add')
  .description('Add a new provider')
  .argument('<name>', 'Provider name (e.g. openrouter, deepseek, ollama)')
  .argument('<baseUrl>', 'API base URL (e.g. https://openrouter.ai/api/v1)')
  .argument('<apiKey>', 'API key')
  .action(async (name, baseUrl, apiKey) => {
    const cfg = readConfig();
    cfg.providers = cfg.providers || {};
    cfg.providers[name] = { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, authHeader: 'Authorization', authPrefix: 'Bearer ' };
    writeConfig(cfg);
    console.log(color('  ✓ Provider added: ' + name + ' → ' + baseUrl, C.green));
    try { await api('/admin/reload', { method: 'POST' }); } catch {}
  });

// ── provider remove ──
program.command('provider-remove')
  .description('Remove a provider')
  .argument('<name>', 'Provider name')
  .action(async (name) => {
    const cfg = readConfig();
    if (!cfg.providers[name]) return console.log(color('  ✗ Provider not found: ' + name, C.yellow));
    delete cfg.providers[name];
    // Clean up mappings using this provider
    for (const [k, v] of Object.entries(cfg.mappings || {})) {
      if (v.startsWith(name + ':')) delete cfg.mappings[k];
    }
    writeConfig(cfg);
    console.log(color('  ✓ Provider removed: ' + name, C.green));
    console.log(color('  (mappings using this provider were also removed)', C.dim));
    try { await api('/admin/reload', { method: 'POST' }); } catch {}
  });

// ── models ──
program.command('models')
  .description('List all model mappings (provider:model)')
  .action(() => {
    banner();
    const cfg = readConfig();
    const entries = Object.entries(cfg.mappings || {}).filter(([k]) => k !== 'default');
    const def = cfg.default || '(none)';
    console.log(color('  Model Mappings', C.bright) + color('  —  Default: ' + def, C.dim));
    console.log('');
    if (!entries.length) return console.log(color('  (no mappings defined)', C.dim));
    for (const [spoof, target] of entries) {
      const ci = target.indexOf(':');
      const prov = ci > 0 ? target.slice(0, ci) : '?';
      const mdl = ci > 0 ? target.slice(ci + 1) : target;
      const providerColor = cfg.providers[prov] ? C.green : C.red;
      console.log(`    ${color(spoof.padEnd(35), C.cyan)} ${color('→', C.dim)} ${color(prov, providerColor)}:${color(mdl, C.bright)}`);
    }
    console.log('');
  });

// ── model add (alias: add) ──
program.command('add')
  .description('Add a model mapping (format: provider:model)')
  .argument('<spoof>', 'Claude model name to spoof')
  .argument('<target>', 'Target in provider:model format (e.g. openrouter:deepseek/deepseek-chat)')
  .action(async (spoof, target) => {
    const colon = target.indexOf(':');
    if (colon <= 0) return console.log(color('  ✗ Target must be provider:model (e.g. openrouter:deepseek/deepseek-chat)', C.red));
    const cfg = readConfig();
    cfg.mappings = cfg.mappings || {};
    cfg.mappings[spoof] = target;
    writeConfig(cfg);
    console.log(color('  ✓ Mapping added: ' + spoof + ' → ' + target, C.green));
    try { await api('/admin/reload', { method: 'POST' }); } catch {}
  });

program.command('remove')
  .description('Remove a model mapping')
  .argument('<spoof>', 'Claude model name to remove')
  .action(async (spoof) => {
    const cfg = readConfig();
    if (!cfg.mappings[spoof]) return console.log(color('  ✗ Mapping not found: ' + spoof, C.yellow));
    delete cfg.mappings[spoof];
    writeConfig(cfg);
    console.log(color('  ✓ Mapping removed: ' + spoof, C.green));
    try { await api('/admin/reload', { method: 'POST' }); } catch {}
  });

// ── switch ──
program.command('switch')
  .description('Change a mapping target (real-time switch)')
  .argument('<spoof>', 'Claude model name')
  .argument('<target>', 'New target in provider:model format')
  .action(async (spoof, target) => {
    const colon = target.indexOf(':');
    if (colon <= 0) return console.log(color('  ✗ Target must be provider:model', C.red));
    const cfg = readConfig();
    if (!cfg.mappings[spoof]) return console.log(color('  ✗ Mapping not found: ' + spoof, C.yellow));
    cfg.mappings[spoof] = target;
    writeConfig(cfg);
    console.log(color('  ✓ Switched: ' + spoof + ' → ' + target, C.green));
    try { await api('/admin/reload', { method: 'POST' }); } catch {}
  });

// ── reload ──
program.command('reload')
  .description('Hot-reload config.json')
  .action(async () => {
    try {
      const r = await api('/admin/reload', { method: 'POST' });
      if (r.status === 200) console.log(color('  ✓ Config reloaded (' + r.data.providers + ' providers, ' + r.data.mappings + ' mappings)', C.green));
      else console.log(color('  ✗ Reload failed', C.red));
    } catch { console.log(color('  ✗ Proxy not running', C.yellow)); }
  });

// ── config ──
// ── config ──
program.command('config')
  .description('Open config.json (or launch interactive TUI)')
  .option('-e, --edit', 'Open in system-default editor')
  .option('-s, --shell', 'Launch interactive TUI editor in terminal')
  .action(async (opts) => {
    if (opts.edit) {
      try { execSync(`cmd /c start "" "${CONFIG_FILE}"`, { stdio: 'ignore', timeout: 3000 }); }
      catch { try { spawn(process.env.EDITOR || 'notepad', [CONFIG_FILE], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
      console.log(color('  ✓ Opened config.json in default editor', C.green));
      return;
    }
    if (opts.shell) {
      await interactiveConfigEditor();
      return;
    }
    // Default: show
    banner();
    const cfg = readConfig();
    console.log(color('  Providers:', C.bright));
    for (const [name, prov] of Object.entries(cfg.providers || {})) {
      console.log(color(`    ${name.padEnd(16)} ${prov.baseUrl} [${(prov.apiKey || '').slice(0, 8)}...]`, C.dim));
    }
    console.log(color('\n  Mappings:', C.bright));
    for (const [spoof, target] of Object.entries(cfg.mappings || {})) {
      if (spoof === 'default') continue;
      console.log(color(`    ${spoof.padEnd(35)} → ${target}`, C.dim));
    }
    console.log(color(`\n  Default: ${cfg.default || '(none)'}`, C.dim));
    console.log(color(`  File:    ${CONFIG_FILE}`, C.dim));
    console.log(color(`  Edit:    csp config -e   (system editor)`, C.dim));
    console.log(color(`           csp config -s   (terminal UI)`, C.dim));
  });

async function interactiveConfigEditor() {
  let cfg = readConfig();
  let dirty = false;

  const menuChoices = () => {
    const items = [];
    const provs = Object.entries(cfg.providers || {});
    const maps = Object.entries(cfg.mappings || {}).filter(([k]) => k !== 'default');
    items.push({ name: `── Providers ──`, disabled: true });
    for (const [name, prov] of provs) {
      items.push({ name: `  [P] ${name.padEnd(14)} ${prov.baseUrl}`, value: `p_${name}` });
    }
    items.push({ name: `  ➕ Add provider`, value: 'add_provider' });
    items.push({ name: `── Mappings ──`, disabled: true });
    for (const [spoof, target] of maps) {
      items.push({ name: `  [M] ${spoof.padEnd(33)} → ${target}`, value: `m_${spoof}` });
    }
    items.push({ name: `  ➕ Add mapping`, value: 'add_mapping' });
    items.push({ name: `── Actions ──`, disabled: true });
    if (dirty) items.push({ name: `  💾 Save & reload`, value: 'save' });
    items.push({ name: `  🔄 Reload from disk`, value: 'reload' });
    items.push({ name: `  ❌ Exit`, value: 'exit' });
    return items;
  };

  while (true) {
    console.clear();
    console.log(color(`\n  ╔══════════════════════════════════════════╗`, C.cyan));
    console.log(color(`  ║      Config Editor  —  Terminal UI      ║`, C.cyan));
    console.log(color(`  ╚══════════════════════════════════════════╝`, C.cyan));
    console.log(color(`  default: ${cfg.default || '(none)'}`, dirty ? C.yellow : C.dim));
    console.log('');

    const { action } = await inquirer.prompt([{
      type: 'list', name: 'action', pageSize: 20,
      message: 'Select item to edit:',
      choices: menuChoices(),
      loop: false,
    }]);

    if (action === 'exit') break;
    if (action === 'save') { saveCfg(); dirty = false; continue; }
    if (action === 'reload') { cfg = readConfig(); dirty = false; continue; }
    if (action === 'add_provider') {
      const ans = await inquirer.prompt([
        { type: 'input', name: 'name', message: 'Provider name:', validate: v => v.trim() ? true : 'required' },
        { type: 'input', name: 'baseUrl', message: 'Base URL:', validate: v => v.startsWith('http') ? true : 'must start with http' },
        { type: 'password', name: 'apiKey', message: 'API key:', validate: v => v.trim() ? true : 'required' },
      ]);
      cfg.providers = cfg.providers || {};
      cfg.providers[ans.name.trim()] = { baseUrl: ans.baseUrl.replace(/\/+$/, ''), apiKey: ans.apiKey, authHeader: 'Authorization', authPrefix: 'Bearer ' };
      dirty = true;
      continue;
    }
    if (action === 'add_mapping') {
      const ans = await inquirer.prompt([
        { type: 'input', name: 'spoof', message: 'Claude model name (e.g. claude-sonnet-4-20250514):', validate: v => v.trim() ? true : 'required' },
        { type: 'input', name: 'target', message: 'Target (provider:model, e.g. ollama:gemma4:31b-cloud):', validate: v => v.includes(':') ? true : 'must include colon' },
      ]);
      cfg.mappings = cfg.mappings || {};
      cfg.mappings[ans.spoof.trim()] = ans.target.trim();
      dirty = true;
      continue;
    }

    // Edit provider
    if (action.startsWith('p_')) {
      const name = action.slice(2);
      const prov = cfg.providers[name];
      const ans = await inquirer.prompt([
        { type: 'input', name: 'baseUrl', message: `Base URL for ${name}:`, default: prov.baseUrl },
        { type: 'password', name: 'apiKey', message: `API key for ${name}:`, default: prov.apiKey },
      ]);
      cfg.providers[name] = { ...prov, baseUrl: ans.baseUrl.replace(/\/+$/, ''), apiKey: ans.apiKey };
      dirty = true;
      continue;
    }

    // Edit mapping
    if (action.startsWith('m_')) {
      const spoof = action.slice(2);
      const current = cfg.mappings[spoof];
      const ans = await inquirer.prompt([
        { type: 'input', name: 'target', message: `Target for ${spoof}:`, default: current },
        { type: 'list', name: 'what', message: 'Also:', choices: [{ name: 'Save', value: 'save' }, { name: 'Delete this mapping', value: 'delete' }] },
      ]);
      if (ans.what === 'delete') { delete cfg.mappings[spoof]; }
      else { cfg.mappings[spoof] = ans.target.trim(); }
      dirty = true;
      continue;
    }
  }

  if (dirty) {
    const { s } = await inquirer.prompt([{ type: 'confirm', name: 's', message: 'Unsaved changes. Save?', default: true }]);
    if (s) saveCfg();
  }

  function saveCfg() {
    writeConfig(cfg);
    try { http.request(`${CONFIG.host}:${CONFIG.port}/admin/reload`, { method: 'POST' }).end(); } catch {}
    console.log(color('\n  ✓ Saved & reloaded\n', C.green));
  }
}

// ── logs ──
program.command('logs')
  .description('Tail proxy logs')
  .option('-n, --lines <n>', 'Lines to show', '20')
  .action((opts) => {
    const logFile = path.join(ROOT, 'proxy.log');
    if (!fs.existsSync(logFile)) return console.log(color('  ✗ No log file found', C.yellow));
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    const tail = lines.slice(-parseInt(opts.lines));
    banner();
    console.log(color('  Recent logs (' + tail.length + ' lines):\n', C.bright));
    for (const l of tail) console.log('  ' + l);
  });

// ── dashboard ──
program.command('dashboard')
  .description('Live dashboard (Ctrl+C to exit)')
  .action(async () => {
    banner();
    if (!isRunning()) return console.log(color('  ✗ Proxy not running. Start with "csp start"', C.red));
    console.log(color('  Live Dashboard (refreshing every 3s, Ctrl+C to exit)\n', C.dim));
    const iv = setInterval(async () => {
      try {
        const s = await api('/admin/stats');
        if (s.status !== 200) return;
        const d = s.data;
        const lines = [];
        lines.push(color('  ● RUNNING' + ' '.repeat(18) + 'PID: ' + d.pid + ' │ Uptime: ' + Math.floor(d.uptime / 60) + 'm ' + (d.uptime % 60) + 's', C.green));
        lines.push(color('  ─' + '─'.repeat(50), C.dim));
        lines.push(color(`  Requests: ${d.requests}  │  Errors: ${d.errors}  │  Providers: ${(d.providers || []).length}  │  Mappings: ${(d.modelMappings || []).length}`, C.bright));
        lines.push('');
        if (Object.keys(d.byProvider).length) {
          lines.push(color('  By provider:', C.cyan));
          for (const [m, c] of Object.entries(d.byProvider)) {
            lines.push(color(`    ${m.padEnd(20)} ${'█'.repeat(Math.min(c, 20))} ${c}`, C.dim));
          }
          lines.push('');
        }
        if (d.modelMappings?.length) {
          lines.push(color('  Mappings:', C.cyan));
          for (const m of d.modelMappings.slice(0, 6)) {
            lines.push(color(`    ${m.spoof.padEnd(32)} → ${m.target}`, C.dim));
          }
        }
        console.clear();
        console.log(lines.join('\n'));
      } catch {
        console.clear();
        console.log(color('  ● Connection lost', C.red));
        clearInterval(iv);
      }
    }, 3000);
    process.on('SIGINT', () => { clearInterval(iv); console.log(''); process.exit(); });
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) { banner(); program.outputHelp(); }
