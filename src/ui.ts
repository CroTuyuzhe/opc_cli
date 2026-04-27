import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import ora, { type Ora } from 'ora';
import { select } from '@inquirer/prompts';
import readline from 'readline';

const COLLAPSE_THRESHOLD = 5;

// === CJK display width ===

function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20) return 0;
  return isWideChar(cp) ? 2 : 1;
}

export function stringDisplayWidth(str: string): number {
  let w = 0;
  for (const ch of str) w += charDisplayWidth(ch);
  return w;
}

// === Custom Line Editor (replaces readline for REPL input) ===

export class LineEditor {
  private prompt: string;
  private buf: string[] = [];
  private cursor = 0;
  private _active = false;
  private resolveFn: ((line: string | null) => void) | null = null;
  private boundOnData: ((data: string) => void) | null = null;

  constructor(prompt: string) {
    this.prompt = prompt;
  }

  setPrompt(p: string) { this.prompt = p; }
  isActive(): boolean { return this._active; }

  readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      this.buf = [];
      this.cursor = 0;
      this._active = true;
      this.resolveFn = resolve;
      process.stdout.write(this.prompt);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf-8');
      process.stdin.resume();
      this.boundOnData = (data: string) => this.onData(data);
      process.stdin.on('data', this.boundOnData);
    });
  }

  interrupt(writeFn: () => void): void {
    if (!this._active) return;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    writeFn();
    this.redraw();
  }

  private cleanup(): void {
    this._active = false;
    if (this.boundOnData) {
      process.stdin.removeListener('data', this.boundOnData);
      this.boundOnData = null;
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  private finish(result: string | null): void {
    this.cleanup();
    process.stdout.write('\n');
    this.resolveFn?.(result);
    this.resolveFn = null;
  }

  private onData(data: string): void {
    for (let i = 0; i < data.length; ) {
      const cp = data.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      i += ch.length;

      if (cp === 27 && i < data.length && data[i] === '[') {
        i++;
        if (i < data.length) {
          const code = data[i]; i++;
          if (code === 'C' && this.cursor < this.buf.length) { this.cursor++; this.redraw(); }
          else if (code === 'D' && this.cursor > 0) { this.cursor--; this.redraw(); }
          else if (code === 'H') { this.cursor = 0; this.redraw(); }
          else if (code === 'F') { this.cursor = this.buf.length; this.redraw(); }
          else if (code === '3' && i < data.length && data[i] === '~') {
            i++;
            if (this.cursor < this.buf.length) { this.buf.splice(this.cursor, 1); this.redraw(); }
          }
        }
        continue;
      }
      if (cp === 27) continue;

      if (cp === 3) { this.finish(''); return; }
      if (cp === 4 && this.buf.length === 0) { this.finish(null); return; }
      if (cp === 4) continue;
      if (cp === 13 || cp === 10) { this.finish(this.buf.join('')); return; }

      if (cp === 127 || cp === 8) {
        if (this.cursor > 0) { this.buf.splice(this.cursor - 1, 1); this.cursor--; this.redraw(); }
        continue;
      }
      if (cp === 1) { this.cursor = 0; this.redraw(); continue; }
      if (cp === 5) { this.cursor = this.buf.length; this.redraw(); continue; }
      if (cp === 21) { this.buf.splice(0, this.cursor); this.cursor = 0; this.redraw(); continue; }
      if (cp === 11) { this.buf.splice(this.cursor); this.redraw(); continue; }
      if (cp === 23) {
        while (this.cursor > 0 && this.buf[this.cursor - 1] === ' ') { this.buf.splice(this.cursor - 1, 1); this.cursor--; }
        while (this.cursor > 0 && this.buf[this.cursor - 1] !== ' ') { this.buf.splice(this.cursor - 1, 1); this.cursor--; }
        this.redraw(); continue;
      }
      if (cp >= 32) { this.buf.splice(this.cursor, 0, ch); this.cursor++; this.redraw(); }
    }
  }

  private redraw(): void {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(this.prompt + this.buf.join(''));
    const col = stringDisplayWidth(this.prompt) + this.widthSlice(0, this.cursor);
    readline.cursorTo(process.stdout, col);
  }

  private widthSlice(start: number, end: number): number {
    let w = 0;
    for (let i = start; i < end && i < this.buf.length; i++) w += charDisplayWidth(this.buf[i]);
    return w;
  }
}

const SPINNER_VERBS = [
  'Thinking', 'Reasoning', 'Analyzing', 'Planning', 'Composing',
  'Synthesizing', 'Processing', 'Evaluating', 'Crafting', 'Exploring',
];

function randomVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

let _spinner: Ora | null = null;
let _spinnerStart = 0;
let _spinnerTimer: ReturnType<typeof setInterval> | null = null;
let _spinnerVerb = '';

export function startSpinner(): void {
  if (_spinner) stopSpinner();
  _spinnerVerb = randomVerb();
  _spinnerStart = Date.now();
  _spinner = ora({
    text: chalk.dim(`${_spinnerVerb}…`),
    spinner: 'dots',
    color: 'cyan',
  }).start();
  _spinnerTimer = setInterval(() => {
    if (_spinner) {
      const elapsed = formatElapsed(Date.now() - _spinnerStart);
      _spinner.text = chalk.dim(`${_spinnerVerb}… (${elapsed})`);
    }
  }, 1000);
}

export function stopSpinner(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): void {
  if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
  if (!_spinner) return;
  const elapsed = formatElapsed(Date.now() - _spinnerStart);
  let info = elapsed;
  if (usage?.completion_tokens) {
    info += ` · ↓ ${formatTokens(usage.completion_tokens)} tokens`;
  }
  _spinner.stopAndPersist({
    symbol: chalk.cyan('✦'),
    text: chalk.dim(`${_spinnerVerb}… (${info})`),
  });
  _spinner = null;
}

let _rl: readline.Interface | null = null;
let _promptActive = false;

export function setReadline(rl: readline.Interface) {
  _rl = rl;
}

export function getReadline(): readline.Interface | null {
  return _rl;
}

export function isPromptActive(): boolean {
  return _promptActive;
}

function rlQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (!_rl) {
      const tmpRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      tmpRl.question(prompt, (answer) => {
        tmpRl.close();
        resolve(answer);
      });
      return;
    }
    _rl.question(prompt, (answer) => resolve(answer));
  });
}

const ROLE_LABEL: Record<string, string> = {
  pm: 'PM',
  dev: 'Dev',
  ui: 'UI',
  tester: 'Test',
  admin: 'Admin',
  brain: 'OPC',
};

const STATE_ICON: Record<string, string> = {
  working: chalk.green('●'),
  queued: chalk.yellow('●'),
  idle: chalk.dim('○'),
};

export function printWelcome(configOk: boolean, provider: string, model: string, teamRoot: string, maxTokens?: number, temperature?: number, version?: string) {
  const lines = [
    chalk.bold('OPC Team Agent') + ` v${version ?? '0.1'}`,
    '',
    `  Provider   : ${chalk.cyan(provider)}`,
    `  Model      : ${chalk.cyan(model)}`,
    `  Max Tokens : ${chalk.cyan(String(maxTokens ?? 8192))}`,
    `  Temperature: ${chalk.cyan(String(temperature ?? 0.7))}`,
    `  Team Root  : ${chalk.cyan(teamRoot)}`,
    `  Config     : ${configOk ? chalk.green('OK') : chalk.red('Missing api_key')}`,
    '',
    chalk.dim('  /help for commands, /exit to quit'),
  ];
  console.log(boxen(lines.join('\n'), { padding: 1, borderColor: 'blue', borderStyle: 'round' }));
}

export function printStatus(status: Record<string, { state: string; inbox: number; active: number }>) {
  const parts = Object.entries(status).map(([role, info]) => {
    const icon = STATE_ICON[info.state] ?? '○';
    const label = ROLE_LABEL[role] ?? role;
    return `${icon} ${label}`;
  });
  console.log(parts.join(' │ '));
}

export function printTasks(tasks: Array<Record<string, any>>) {
  if (tasks.length === 0) {
    console.log(chalk.dim('No tasks'));
    return;
  }
  const table = new Table({ head: ['ID', 'To', 'Title', 'Status'] });
  for (const t of tasks) {
    table.push([t.id ?? '', t.to ?? '', t.title ?? '', t.status ?? '']);
  }
  console.log(table.toString());
}

export function printInbox(role: string, tasks: Array<Record<string, any>>) {
  if (tasks.length === 0) {
    console.log(chalk.dim(`${ROLE_LABEL[role] ?? role} inbox is empty`));
    return;
  }
  for (const t of tasks) {
    console.log(`  [${t.id ?? ''}] ${t.title ?? ''}`);
  }
}

export function printHelp() {
  const cmds: [string, string][] = [
    ['/status', 'Show agent status'],
    ['/tasks', 'Show task queue'],
    ['/inbox <role>', 'View role inbox (pm/dev/ui/tester/admin)'],
    ['/dispatch', 'Manually dispatch a task'],
    ['/skills', 'List available tools'],
    ['/skill list', 'List installed skills'],
    ['/skill install <url>', 'Install skill from GitHub'],
    ['/skill remove <name>', 'Remove a skill'],
    ['/new', 'Start fresh conversation (clear context)'],
    ['/task', 'List all tasks (active + recent)'],
    ['/task <id>', 'View task details'],
    ['/task <id> close', 'Close and archive a task'],
    ['/compact', 'Toggle compact output'],
    ['/uninstall', 'Remove OPC from system'],
    ['/help', 'This help'],
    ['/exit', 'Quit'],
  ];
  const table = new Table({ chars: { mid: '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' }, style: { head: [], border: [] } });
  for (const [cmd, desc] of cmds) {
    table.push([chalk.cyan(cmd), desc]);
  }
  console.log(table.toString());
}

export function printSkills(extraSkills?: Array<{ name: string; description: string }> | null) {
  const builtins: [string, string][] = [
    ['dispatch_task', 'Send task to a role'],
    ['read_workspace_file', 'Read workspace file'],
    ['write_workspace_file', 'Write workspace file'],
    ['get_project_status', 'Get all agent status'],
    ['execute_role_task', 'Run role agent on task'],
    ['run_bash', 'Run shell command (requires user approval)'],
    ['ask_user', 'Ask user for approval or clarification'],
  ];
  console.log(chalk.bold('  Built-in:'));
  for (const [name, desc] of builtins) {
    console.log(`    ${chalk.cyan(name)} — ${desc}`);
  }
  if (extraSkills && extraSkills.length > 0) {
    console.log(chalk.bold('  Skills:'));
    for (const s of extraSkills) {
      console.log(`    ${chalk.cyan('skill_' + s.name)} — ${s.description}`);
    }
  }
}

export function printError(msg: string) {
  console.log(chalk.red(msg));
}

export function printAgentWorking(role: string, taskTitle: string) {
  const label = ROLE_LABEL[role] ?? role;
  console.log(`  ${chalk.green('▶')} ${label} working on: ${taskTitle}`);
}

export function printAgentDone(role: string, summary: string) {
  const label = ROLE_LABEL[role] ?? role;
  console.log(`  ${chalk.green('✓')} ${label} done: ${summary.slice(0, 120)}`);
}

export function printFileWritten(role: string, filePath: string) {
  const label = ROLE_LABEL[role] ?? role;
  console.log(`  ${chalk.cyan('📄')} ${label} wrote: ${filePath}`);
}

export function printInterventionBlock(state: string) {
  console.log(boxen(
    chalk.bold.red(`Intervention state: ${state}`) +
    '\nAll dispatches are blocked. Change intervention.md to RUNNING to resume.',
    { padding: 1, borderColor: 'red', title: '⚠ BLOCKED', titleAlignment: 'left' }
  ));
}

export function printDeepthinkQuestion(role: string, question: string) {
  const label = ROLE_LABEL[role] ?? role;
  console.log(chalk.dim('  ─'.repeat(20)));
  console.log(`  ${chalk.yellow('?')} ${chalk.bold(`${label} asks:`)} ${question}`);
}

export function printTaskNotification(role: string, taskTitle: string, summary: string, artifactPath = '') {
  const label = ROLE_LABEL[role] ?? role;
  let text = `${chalk.green('✓')} ${chalk.bold(label)} completed: ${taskTitle}\n\n${summary.slice(0, 300)}`;
  if (artifactPath) text += `\n\n${chalk.dim(`Artifact: ${artifactPath}`)}`;
  console.log(boxen(text, { padding: 1, borderColor: 'green', title: 'Task Completed', titleAlignment: 'left' }));
}

export function collapseText(text: string, indent = '  '): string {
  const lines = text.split('\n');
  if (lines.length <= COLLAPSE_THRESHOLD) {
    return lines.map(l => `${indent}${l}`).join('\n');
  }
  const shown = lines.slice(0, COLLAPSE_THRESHOLD);
  const hidden = lines.length - COLLAPSE_THRESHOLD;
  return [
    ...shown.map(l => `${indent}${l}`),
    `${indent}${chalk.dim(`... +${hidden} lines`)}`,
  ].join('\n');
}

export function printBashOutput(stdout: string, stderr: string, returncode: number) {
  if (stdout) {
    console.log(collapseText(stdout));
  }
  if (stderr) {
    const lines = stderr.split('\n');
    if (lines.length <= COLLAPSE_THRESHOLD) {
      for (const line of lines) console.log(`  ${chalk.red(line)}`);
    } else {
      for (const line of lines.slice(0, COLLAPSE_THRESHOLD)) console.log(`  ${chalk.red(line)}`);
      console.log(`  ${chalk.dim(`... +${lines.length - COLLAPSE_THRESHOLD} lines`)}`);
    }
  }
  if (returncode !== 0) {
    console.log(`  ${chalk.red(`Exit code: ${returncode}`)}`);
  }
}

export async function promptUserAnswer(): Promise<string> {
  stopSpinner();
  try {
    const answer = await rlQuestion(`  ${chalk.bgHex('#1e3a5f').white(' > ')} `);
    const trimmed = answer.trim() || '(no answer)';
    console.log(`  ${chalk.bgHex('#1e3a5f').white(` ${trimmed} `)}`);
    return trimmed;
  } catch {
    return '(skipped)';
  }
}

export async function promptUserSelect(options: Array<{ label: string; value: string }>): Promise<string> {
  const choices = [
    ...options.map(o => ({ name: o.label, value: o.value })),
    { name: '自由输入...', value: '__chat__' },
  ];
  stopSpinner();
  _promptActive = true;
  try {
    if (_rl) _rl.pause();
    const answer = await select({ message: 'Choose:', choices });
    if (_rl) _rl.resume();
    _promptActive = false;
    if (answer === '__chat__') {
      return promptUserAnswer();
    }
    return answer;
  } catch {
    if (_rl) _rl.resume();
    _promptActive = false;
    return '(skipped)';
  }
}

export async function promptBashApproval(command: string, description = ''): Promise<'yes' | 'always' | 'no'> {
  stopSpinner();
  console.log();
  if (description) console.log(`  ${chalk.dim(description)}`);
  console.log(`  ${chalk.bold.yellow('$')} ${chalk.white(command)}`);
  console.log();
  _promptActive = true;
  try {
    if (_rl) _rl.pause();
    const answer = await select({
      message: 'Run this command?',
      choices: [
        { name: 'Yes', value: 'yes' },
        { name: 'Always approve for this session', value: 'always' },
        { name: 'No', value: 'no' },
      ],
    });
    if (_rl) _rl.resume();
    _promptActive = false;
    return answer as 'yes' | 'always' | 'no';
  } catch {
    if (_rl) _rl.resume();
    _promptActive = false;
    return 'no';
  }
}
