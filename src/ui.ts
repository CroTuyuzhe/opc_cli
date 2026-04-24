import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import ora, { type Ora } from 'ora';
import { select } from '@inquirer/prompts';
import readline from 'readline';

const COLLAPSE_THRESHOLD = 5;

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
