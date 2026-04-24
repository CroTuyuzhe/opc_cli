import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { select, input, password } from '@inquirer/prompts';

const ROLES = ['pm', 'dev', 'ui', 'tester', 'admin'];

const RUNTIME_DIRS = [
  'communication/bus/{role}/inbox',
  'communication/bus/{role}/active',
  'workspace',
  'memory_center/archive',
  'memory_center/project_history',
];

function scaffoldRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, '..', 'scaffold');
}

const PROVIDER_PRESETS: Record<string, { base_url: string; default_model: string }> = {
  openai: { base_url: 'https://api.openai.com/v1', default_model: 'gpt-4o' },
  anthropic: { base_url: '', default_model: 'claude-sonnet-4-20250514' },
};

export async function initProject(target: string) {
  target = path.resolve(target);
  const scaffold = scaffoldRoot();

  if (!fs.existsSync(scaffold)) {
    console.log(chalk.red('Error: scaffold data not found in package.'));
    return;
  }

  const created: string[] = [];
  const skipped: string[] = [];

  const allFiles = getAllFiles(scaffold).filter(f => !path.basename(f).startsWith('.'));
  for (const srcFile of allFiles.sort()) {
    const rel = path.relative(scaffold, srcFile);
    const dst = path.join(target, rel);
    if (fs.existsSync(dst)) {
      skipped.push(rel);
      continue;
    }
    fs.ensureDirSync(path.dirname(dst));
    fs.copyFileSync(srcFile, dst);
    created.push(rel);
  }

  const opcJson = path.join(target, 'opc.json');
  if (!fs.existsSync(opcJson)) {
    const example = path.join(target, 'opc.json.example');
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, opcJson);
      created.push('opc.json');
    }
  }

  for (const pattern of RUNTIME_DIRS) {
    if (pattern.includes('{role}')) {
      for (const role of ROLES) {
        fs.ensureDirSync(path.join(target, pattern.replace('{role}', role)));
      }
    } else {
      fs.ensureDirSync(path.join(target, pattern));
    }
  }

  console.log(`\n${chalk.bold.green(`OPC initialized in ${target}`)}\n`);
  if (created.length > 0) {
    for (const f of created) {
      console.log(`  ${chalk.green('+')} ${f}`);
    }
  }
  if (skipped.length > 0) {
    console.log(`\n  ${chalk.dim(`${skipped.length} existing files unchanged`)}`);
  }
  await configWizard(target);
}

async function configWizard(target: string) {
  const opcJson = path.join(target, 'opc.json');
  const existing = fs.existsSync(opcJson) ? fs.readJsonSync(opcJson) : null;

  if (existing && existing.api_key) {
    console.log(chalk.dim(`\n  opc.json already configured (api_key set).`));
    console.log(`\n  Run ${chalk.cyan('opc')} to start\n`);
    return;
  }

  console.log(`\n${chalk.bold('⚙  Configure your AI provider:')}\n`);

  try {
    const provider = await select({
      message: 'Provider',
      choices: [
        { name: 'OpenAI (compatible with DeepSeek, Moonshot, etc.)', value: 'openai' },
        { name: 'Anthropic Claude', value: 'anthropic' },
      ],
    });

    const preset = PROVIDER_PRESETS[provider];

    const apiKey = await password({
      message: 'API Key',
      mask: '*',
    });

    const baseUrl = provider === 'openai'
      ? await input({
          message: 'Base URL',
          default: preset.base_url,
        })
      : preset.base_url;

    const model = await input({
      message: 'Model',
      default: preset.default_model,
    });

    const config: Record<string, any> = {
      provider,
      api_key: apiKey,
      default_model: model,
      team_root: '.',
      max_tokens: 8192,
      temperature: 0.7,
    };
    if (baseUrl) config.base_url = baseUrl;

    fs.writeJsonSync(opcJson, config, { spaces: 4 });

    console.log(`\n  ${chalk.green('✅')} Configuration saved to ${chalk.cyan('opc.json')}`);
    console.log(`\n  Run ${chalk.cyan('opc')} to start!\n`);
  } catch {
    console.log(chalk.dim('\n  Configuration skipped. Edit opc.json manually.'));
    console.log(`\n  Run ${chalk.cyan('opc')} to start\n`);
  }
}

function getAllFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}
