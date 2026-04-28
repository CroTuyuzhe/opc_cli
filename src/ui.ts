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

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stringDisplayWidth(str: string): number {
  const clean = str.replace(ANSI_RE, '');
  let w = 0;
  for (const ch of clean) w += charDisplayWidth(ch);
  return w;
}

// === Slash command registry (shared by help + autocomplete) ===

export const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/status', desc: 'Show agent status' },
  { cmd: '/tasks', desc: 'Show task queue' },
  { cmd: '/inbox', desc: 'View role inbox' },
  { cmd: '/dispatch', desc: 'Manually dispatch a task' },
  { cmd: '/skills', desc: 'List available tools' },
  { cmd: '/skill', desc: 'Manage installed skills' },
  { cmd: '/new', desc: 'Start fresh conversation' },
  { cmd: '/task', desc: 'List or manage tasks' },
  { cmd: '/superagent', desc: 'Toggle SuperAgent mode' },
  { cmd: '/compact', desc: 'Toggle compact output' },
  { cmd: '/uninstall', desc: 'Remove OPC from system' },
  { cmd: '/help', desc: 'Show help' },
  { cmd: '/exit', desc: 'Quit' },
];

// === Custom Line Editor (replaces readline for REPL input) ===

export class LineEditor {
  private inputPrompt: string;
  private label: string;
  private buf: string[] = [];
  private cursor = 0;
  private _active = false;
  private resolveFn: ((line: string | null) => void) | null = null;
  private boundOnData: ((data: string) => void) | null = null;
  private pasting = false;
  private completions: Array<{ cmd: string; desc: string }> = [];
  private completionIdx = -1;
  private completionActive = false;
  private inPager = false;
  private pagerLines: string[] = [];
  private pagerOffset = 0;

  constructor(inputPrompt: string, label = 'opc') {
    this.inputPrompt = inputPrompt;
    this.label = label;
  }

  setLabel(l: string) { this.label = l; }
  isActive(): boolean { return this._active; }

  private getCols(): number { return process.stdout.columns || 80; }

  private buildTopLine(): string {
    const cols = this.getCols();
    const suffix = ' ' + this.label + ' ──';
    const lineLen = Math.max(0, cols - suffix.length);
    return chalk.dim('─'.repeat(lineLen) + suffix);
  }

  private buildBottomLine(): string {
    return chalk.dim('─'.repeat(this.getCols()));
  }

  private drawFull(): void {
    process.stdout.write(this.buildTopLine() + '\n');
    const text = this.buf.join('');
    process.stdout.write(this.inputPrompt + text + '\n');
    process.stdout.write(this.buildBottomLine());
    process.stdout.write('\x1b[A');
    const col = stringDisplayWidth(this.inputPrompt) + this.widthSlice(0, this.cursor);
    readline.cursorTo(process.stdout, col);
  }

  readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      this.buf = [];
      this.cursor = 0;
      this._active = true;
      this.resolveFn = resolve;
      this.drawFull();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdout.write('\x1b[?2004h');
      process.stdin.setEncoding('utf-8');
      process.stdin.resume();
      this.boundOnData = (data: string) => this.onData(data);
      process.stdin.on('data', this.boundOnData);
    });
  }

  interrupt(writeFn: () => void): void {
    if (!this._active) return;
    process.stdout.write('\x1b[A\x1b[G\x1b[J');
    writeFn();
    this.drawFull();
  }

  private cleanup(): void {
    this._active = false;
    this.pasting = false;
    process.stdout.write('\x1b[?2004l');
    if (this.boundOnData) {
      process.stdin.removeListener('data', this.boundOnData);
      this.boundOnData = null;
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  private finishSubmit(result: string): void {
    this.resetCompletions();
    this.cleanup();
    process.stdout.write('\x1b[G\x1b[J');
    process.stdout.write(this.inputPrompt + this.buf.join('') + '\n');
    process.stdout.write(this.buildBottomLine() + '\n');
    this.resolveFn?.(result);
    this.resolveFn = null;
  }

  private finishCancel(): void {
    this.resetCompletions();
    this.cleanup();
    process.stdout.write('\x1b[A\x1b[G\x1b[J');
    this.resolveFn?.('');
    this.resolveFn = null;
  }

  private finishExit(): void {
    this.resetCompletions();
    this.cleanup();
    process.stdout.write('\x1b[A\x1b[G\x1b[J');
    this.resolveFn?.(null);
    this.resolveFn = null;
  }

  private onData(data: string): void {
    for (let i = 0; i < data.length; ) {
      const cp = data.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      i += ch.length;

      if (this.inPager) {
        if (cp === 15 || cp === 3) { this.exitPager(); continue; }
        if (cp === 27 && i < data.length && data[i] === '[') {
          i++;
          if (i < data.length) {
            const code = data[i]; i++;
            const rows = process.stdout.rows || 24;
            const viewable = rows - 2;
            const maxOffset = Math.max(0, this.pagerLines.length - viewable);
            if (code === 'A' && this.pagerOffset > 0) { this.pagerOffset--; this.renderPager(); }
            else if (code === 'B' && this.pagerOffset < maxOffset) { this.pagerOffset++; this.renderPager(); }
          }
        } else if (cp === 27) {
          this.exitPager();
        }
        continue;
      }

      // Bracketed paste: \x1b[200~ ... \x1b[201~
      if (cp === 27 && data.startsWith('[200~', i)) {
        i += 5; this.pasting = true; continue;
      }
      if (cp === 27 && data.startsWith('[201~', i)) {
        i += 5; this.pasting = false; this.redraw(); continue;
      }

      if (this.pasting) {
        if (cp === 13 || cp === 10) {
          this.buf.splice(this.cursor, 0, ' '); this.cursor++;
        } else if (cp >= 32) {
          this.buf.splice(this.cursor, 0, ch); this.cursor++;
        }
        continue;
      }

      if (cp === 27 && i < data.length && data[i] === '[') {
        i++;
        if (i < data.length) {
          const code = data[i]; i++;
          if (code === 'A' && this.completionActive) {
            if (this.completionIdx > 0) this.completionIdx--;
            this.redrawMenu();
            continue;
          }
          if (code === 'B' && this.completionActive) {
            if (this.completionIdx < this.completions.length - 1) this.completionIdx++;
            this.redrawMenu();
            continue;
          }
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
      if (cp === 27) {
        if (this.completionActive) { this.resetCompletions(); this.redraw(); }
        continue;
      }

      if (cp === 9 && this.completionActive && this.completionIdx >= 0) {
        this.applyCompletion(); this.redraw(); continue;
      }
      if (cp === 3) { this.resetCompletions(); this.finishCancel(); return; }
      if (cp === 4 && this.buf.length === 0) { this.resetCompletions(); this.finishExit(); return; }
      if (cp === 4) continue;
      if ((cp === 13 || cp === 10) && this.completionActive && this.completionIdx >= 0) {
        this.applyCompletion(); this.redraw(); continue;
      }
      if (cp === 13 || cp === 10) { this.resetCompletions(); this.finishSubmit(this.buf.join('')); return; }

      if (cp === 127 || cp === 8) {
        if (this.cursor > 0) { this.buf.splice(this.cursor - 1, 1); this.cursor--; this.redraw(); }
        continue;
      }
      if (cp === 1) { this.cursor = 0; this.redraw(); continue; }
      if (cp === 5) { this.cursor = this.buf.length; this.redraw(); continue; }
      if (cp === 21) { this.buf.splice(0, this.cursor); this.cursor = 0; this.redraw(); continue; }
      if (cp === 11) { this.buf.splice(this.cursor); this.redraw(); continue; }
      if (cp === 15 && _lastCollapsed) { this.enterPager(); continue; }
      if (cp === 23) {
        while (this.cursor > 0 && this.buf[this.cursor - 1] === ' ') { this.buf.splice(this.cursor - 1, 1); this.cursor--; }
        while (this.cursor > 0 && this.buf[this.cursor - 1] !== ' ') { this.buf.splice(this.cursor - 1, 1); this.cursor--; }
        this.redraw(); continue;
      }
      if (cp >= 32) { this.buf.splice(this.cursor, 0, ch); this.cursor++; this.redraw(); }
    }
  }

  private redraw(): void {
    this.updateCompletions();
    process.stdout.write('\x1b[G\x1b[J');
    const text = this.buf.join('');
    process.stdout.write(this.inputPrompt + text + '\n' + this.buildBottomLine());

    if (this.completionActive && this.completions.length > 0) {
      const maxCmd = Math.max(...this.completions.map(c => c.cmd.length));
      for (let i = 0; i < this.completions.length; i++) {
        const c = this.completions[i];
        const padded = c.cmd.padEnd(maxCmd + 1);
        if (i === this.completionIdx) {
          process.stdout.write('\n' + chalk.bgCyan.black(` ${padded}`) + ' ' + chalk.dim(c.desc));
        } else {
          process.stdout.write('\n' + chalk.cyan(` ${padded}`) + ' ' + chalk.dim(c.desc));
        }
      }
    }

    const menuLines = this.completionActive ? this.completions.length : 0;
    const up = 1 + menuLines;
    process.stdout.write(`\x1b[${up}A`);
    const col = stringDisplayWidth(this.inputPrompt) + this.widthSlice(0, this.cursor);
    readline.cursorTo(process.stdout, col);
  }

  private enterPager(): void {
    if (!_lastCollapsed) return;
    this.inPager = true;
    this.pagerLines = _lastCollapsed.split('\n');
    this.pagerOffset = 0;
    process.stdout.write('\x1b[?1049h');
    this.renderPager();
  }

  private renderPager(): void {
    const rows = process.stdout.rows || 24;
    const viewable = rows - 1;
    process.stdout.write('\x1b[H\x1b[J');
    const total = this.pagerLines.length;
    const end = Math.min(this.pagerOffset + viewable, total);
    for (let i = this.pagerOffset; i < end; i++) {
      process.stdout.write(this.pagerLines[i] + '\n');
    }
    process.stdout.write(`\x1b[${rows};0H`);
    process.stdout.write(chalk.dim(`─── ${this.pagerOffset + 1}-${end}/${total} (↑↓ scroll, Ctrl+O to close) ───`));
  }

  private exitPager(): void {
    this.inPager = false;
    this.pagerLines = [];
    process.stdout.write('\x1b[?1049l');
    process.stdout.write('\x1b[A\x1b[G\x1b[J');
    this.drawFull();
  }

  private widthSlice(start: number, end: number): number {
    let w = 0;
    for (let i = start; i < end && i < this.buf.length; i++) w += charDisplayWidth(this.buf[i]);
    return w;
  }

  private redrawMenu(): void {
    if (!this.completionActive || this.completions.length === 0) return;
    process.stdout.write('\x1b[G');
    process.stdout.write('\x1b[B');
    process.stdout.write('\x1b[J');
    const maxCmd = Math.max(...this.completions.map(c => c.cmd.length));
    for (let i = 0; i < this.completions.length; i++) {
      const c = this.completions[i];
      const padded = c.cmd.padEnd(maxCmd + 1);
      if (i === this.completionIdx) {
        process.stdout.write('\n' + chalk.bgCyan.black(` ${padded}`) + ' ' + chalk.dim(c.desc));
      } else {
        process.stdout.write('\n' + chalk.cyan(` ${padded}`) + ' ' + chalk.dim(c.desc));
      }
    }
    const up = this.completions.length + 1;
    process.stdout.write(`\x1b[${up}A`);
    const col = stringDisplayWidth(this.inputPrompt) + this.widthSlice(0, this.cursor);
    readline.cursorTo(process.stdout, col);
  }

  private updateCompletions(): void {
    const text = this.buf.join('');
    if (text.startsWith('/') && !text.includes(' ') && text.length > 0) {
      const prefix = text.toLowerCase();
      this.completions = SLASH_COMMANDS.filter(c => c.cmd.startsWith(prefix));
      this.completionActive = this.completions.length > 0;
      this.completionIdx = this.completionActive ? 0 : -1;
    } else {
      this.completions = [];
      this.completionActive = false;
      this.completionIdx = -1;
    }
  }

  private applyCompletion(): void {
    const selected = this.completions[this.completionIdx];
    if (!selected) return;
    this.buf = [...selected.cmd, ' '];
    this.cursor = this.buf.length;
    this.completions = [];
    this.completionActive = false;
    this.completionIdx = -1;
  }

  private resetCompletions(): void {
    this.completions = [];
    this.completionActive = false;
    this.completionIdx = -1;
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
  const table = new Table({ chars: { mid: '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' }, style: { head: [], border: [] } });
  for (const { cmd, desc } of SLASH_COMMANDS) {
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

let _lastCollapsed: string | null = null;

export function getLastCollapsed(): string | null { return _lastCollapsed; }

export function formatText(text: string, indent = '  '): string {
  return text.split('\n').map(l => `${indent}${l}`).join('\n');
}

export function collapseText(text: string, indent = '  '): string {
  const lines = text.split('\n');
  if (lines.length <= COLLAPSE_THRESHOLD) {
    return lines.map(l => `${indent}${l}`).join('\n');
  }
  _lastCollapsed = text;
  const shown = lines.slice(0, COLLAPSE_THRESHOLD);
  const hidden = lines.length - COLLAPSE_THRESHOLD;
  return [
    ...shown.map(l => `${indent}${l}`),
    `${indent}${chalk.dim(`... +${hidden} lines (Ctrl+O)`)}`,
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

export function printSuperAgentStatus(on: boolean) {
  if (on) {
    console.log(boxen(
      chalk.bold.green('SuperAgent: ON') +
      '\n\nBrain will autonomously iterate the project.' +
      '\nask_user → ask_boss (LLM auto-decides)' +
      '\nPress ESC to interrupt at any time.',
      { padding: 1, borderColor: 'green', title: 'SuperAgent', titleAlignment: 'left' }
    ));
  } else {
    console.log(`  ${chalk.dim('SuperAgent: OFF — back to normal mode')}`);
  }
}

export function printBossDecision(question: string, answer: string) {
  console.log(`  ${chalk.magenta('🤖 Boss:')} ${chalk.dim(question)}`);
  console.log(`  ${chalk.magenta('→')} ${answer}`);
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
