#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import chalk from 'chalk';
import { listAllTools, runWorkflow } from './workflow.js';
import { bootstrapSecretsFromKeychain } from './secrets.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
const DEFAULT_PORT = 3847;
function loadConfig(configPath) {
    const candidates = [];
    if (configPath) {
        candidates.push(path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath));
    }
    else {
        candidates.push(path.join(process.cwd(), 'porch.config.json'));
        candidates.push(path.join(PACKAGE_ROOT, 'porch.config.json'));
        candidates.push(path.join(process.cwd(), 'mcp-orchestrator.config.json'));
    }
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            const config = JSON.parse(fs.readFileSync(p, 'utf8'));
            return { config, configDir: path.dirname(p) };
        }
    }
    const example = path.join(PACKAGE_ROOT, 'porch.config.example.json');
    throw new Error(`Config not found. Create one from ${example}`);
}
function getServerUrl() {
    return process.env.PORCH_URL ?? `http://127.0.0.1:${process.env.PORT ?? DEFAULT_PORT}`;
}
async function apiGet(path) {
    const res = await fetch(`${getServerUrl()}${path}`);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Server error ${res.status}: ${text}`);
    }
    return res.json();
}
async function apiPost(path, body) {
    const res = await fetch(`${getServerUrl()}${path}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Server error ${res.status}: ${text}`);
    }
    return res.json();
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--no-color')) {
        chalk.level = 0;
    }
    const [cmd, ...rest] = argv.filter((a) => a !== '--no-color');
    const configPath = rest.find((a) => a.startsWith('--config='))?.slice(9);
    const opts = { configPath, rest, hasHelp: rest.some((a) => a === '--help' || a === '-h') };
    const getOpt = (name) => opts.rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const hasJson = opts.rest.includes('--json');
    const showHelp = (subcommand) => {
        const subcommands = ['list', 'workflow', 'workflows', 'mcps', 'tunnel', 'logs', 'open'];
        if (subcommand && subcommands.includes(subcommand)) {
            const helps = {
                list: `porch list - List tools from all connected MCPs

Usage: porch list [--config=PATH] [--help]`,
                workflow: `porch workflow - Run or inspect workflows

Usage:
  porch workflow <name> [--input=JSON] [--config=PATH] [--help]
  porch workflow show <name> [--config=PATH] [--help]

Options:
  --input=JSON     JSON input for {{input.key}} placeholders (or --input=@file.json)
  --config=PATH    Config file path

Examples:
  porch workflow "Spotify to Pieces"
  porch workflow "Start Study" --input='{"subject":"math"}'`,
                workflows: `porch workflows - List workflows

Usage: porch workflows [--json] [--config=PATH] [--help]`,
                mcps: `porch mcps - List MCPs and status

Usage: porch mcps [--json] [--config=PATH] [--help]`,
                tunnel: `porch tunnel - Tunnel status and control

Usage:
  porch tunnel status
  porch tunnel start
  porch tunnel stop

Requires server running (npm run ui).`,
                logs: `porch logs - Recent logs

Usage: porch logs [--tail=N] [--config=PATH] [--help]

Options:
  --tail=N         Last N entries (default: 50)`,
                open: `porch open - Open Porch UI in browser

Usage: porch open [--help]

Opens the Porch UI (default: http://127.0.0.1:3847). Set PORT or PORCH_URL env for custom port/URL.`,
            };
            console.log(helps[subcommand] + '\n');
            return;
        }
        console.log(`
Porch - Connect MCPs and automate actions between them

Usage: porch <command> [options]

Commands:
  list                      List tools from all connected MCPs
  workflow <name>           Run a workflow [--input=JSON]
  workflow show <name>      Show workflow config
  workflows [--json]        List workflows
  mcps [--json]             List MCPs + status
  tunnel status             Tunnel status
  tunnel start|stop         Start or stop tunnel
  logs [--tail=N]           Recent logs
  open                      Open Porch UI in browser
  help [command]            Show help
  --help, -h                Show this help
  --version, -v             Show version

Options:
  --config=PATH             Config file path (default: cwd or package root)
  --no-color                Disable colored output (for scripts/piping)

Examples:
  porch workflow "Spotify to Pieces"
  porch workflows --json
  porch tunnel status
`);
    };
    switch (cmd) {
        case 'help':
        case '--help':
        case '-h':
            showHelp(cmd === 'help' ? rest.find((a) => !a.startsWith('-')) : undefined);
            return;
        case '--version':
        case '-v':
            console.log(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
            return;
    }
    if (opts.hasHelp && ['list', 'workflow', 'workflows', 'mcps', 'tunnel', 'logs', 'open'].includes(cmd)) {
        showHelp(cmd);
        return;
    }
    if (cmd === 'open') {
        const url = getServerUrl();
        await open(url);
        console.log(chalk.green('Opened'), chalk.cyan(url));
        return;
    }
    bootstrapSecretsFromKeychain();
    const { config, configDir } = loadConfig(configPath);
    switch (cmd) {
        case 'list':
            await listAllTools(config);
            break;
        case 'workflow': {
            const sub = rest.find((a) => !a.startsWith('--'));
            if (sub === 'show') {
                const name = rest.slice(rest.indexOf('show') + 1).find((a) => !a.startsWith('--'));
                if (!name) {
                    console.error(chalk.red('Usage: porch workflow show <name>'));
                    process.exit(1);
                }
                const w = config.workflows.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? config.workflows.find((x) => x.name === name);
                if (!w) {
                    console.error(chalk.red(`Workflow not found: ${name}`));
                    process.exit(1);
                }
                console.log(JSON.stringify(w, null, 2));
                break;
            }
            const name = sub ?? rest.find((a) => !a.startsWith('--'));
            if (!name) {
                console.error(chalk.red('Usage: porch workflow <name>'));
                process.exit(1);
            }
            let input;
            const inputArg = getOpt('input');
            if (inputArg) {
                if (inputArg.startsWith('@')) {
                    const fp = path.resolve(process.cwd(), inputArg.slice(1));
                    input = JSON.parse(fs.readFileSync(fp, 'utf8'));
                }
                else {
                    input = JSON.parse(inputArg);
                }
            }
            const { success } = await runWorkflow(config, name, input);
            process.exit(success ? 0 : 1);
        }
        case 'workflows':
            if (hasJson) {
                console.log(JSON.stringify(config.workflows, null, 2));
            }
            else {
                const amber = chalk.hex('#f59e0b');
                for (const w of config.workflows) {
                    console.log(`  ${amber(w.name)}${w.description ? chalk.dim(` - ${w.description}`) : ''}`);
                }
            }
            break;
        case 'mcps': {
            if (hasJson) {
                const out = Object.entries(config.mcps).map(([n, m]) => ({
                    name: n,
                    type: m.type,
                    enabled: m.enabled !== false,
                }));
                console.log(JSON.stringify(out, null, 2));
            }
            else {
                const serverUrl = getServerUrl();
                try {
                    const status = (await apiGet('/api/mcp-status'));
                    const mcps = status.mcps ?? [];
                    const amber = chalk.hex('#f59e0b');
                    for (const m of mcps) {
                        const cfg = config.mcps[m.name];
                        const ok = cfg && cfg.enabled !== false;
                        const icon = ok ? chalk.green('✓') : chalk.red('✗');
                        const statusColor = m.status === 'connected' ? chalk.green : /fail|error|disconnect/i.test(m.status) ? chalk.red : chalk.dim;
                        console.log(`  ${icon} ${amber(m.name)}: ${statusColor(m.status)}${m.tools != null ? chalk.dim(` (${m.tools} tools)`) : ''}`);
                    }
                }
                catch {
                    const amber = chalk.hex('#f59e0b');
                    for (const [n, m] of Object.entries(config.mcps)) {
                        const ok = m.enabled !== false;
                        const icon = ok ? chalk.green('✓') : chalk.red('✗');
                        console.log(`  ${icon} ${amber(n)} ${chalk.dim(`(${m.type})`)}`);
                    }
                }
            }
            break;
        }
        case 'tunnel': {
            const action = rest.find((a) => !a.startsWith('--'));
            if (!action || !['status', 'start', 'stop'].includes(action)) {
                console.error(chalk.red('Usage: porch tunnel status|start|stop'));
                process.exit(1);
            }
            try {
                if (action === 'status') {
                    const s = (await apiGet('/api/tunnel/status'));
                    const url = s.url ?? s.baseUrl ?? 'yes';
                    console.log(s.active ? chalk.green('Active:') + ' ' + chalk.cyan(url) : chalk.dim('Inactive'));
                }
                else if (action === 'start') {
                    const r = (await apiPost('/api/tunnel/start'));
                    console.log(r.url ? chalk.green('Tunnel started:') + ' ' + chalk.cyan(r.url) : chalk.green('Tunnel starting…'));
                }
                else {
                    await apiPost('/api/tunnel/stop');
                    console.log(chalk.green('Tunnel stopped'));
                }
            }
            catch {
                console.error(chalk.red('Tunnel requires server. Run: npm run ui'));
                process.exit(1);
            }
            break;
        }
        case 'logs': {
            const tail = parseInt(getOpt('tail') ?? '50', 10) || 50;
            const logsPath = path.join(configDir, 'porch.logs.json');
            const legacyPath = path.join(configDir, 'mcp-orchestrator.logs.json');
            let logs = [];
            for (const p of [logsPath, legacyPath]) {
                if (fs.existsSync(p)) {
                    try {
                        logs = JSON.parse(fs.readFileSync(p, 'utf8'));
                    }
                    catch {
                        /* ignore */
                    }
                    break;
                }
            }
            if (!Array.isArray(logs))
                logs = [];
            const slice = logs.slice(0, tail);
            for (const e of slice) {
                const ev = e;
                const icon = ev.success === false ? chalk.red('✗') : chalk.green('✓');
                console.log(`${icon} ${chalk.dim(`[${ev.ts ?? ''}]`)} ${chalk.cyan(ev.type ?? '')}: ${ev.message ?? ''}`);
            }
            break;
        }
        default:
            showHelp();
    }
}
main().catch((err) => {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
});
