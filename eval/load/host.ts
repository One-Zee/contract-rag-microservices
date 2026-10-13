import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { REPO_ROOT } from '../lib/paths.ts';

export interface Provenance {
  commit: string;
  dirty: boolean;
  image: string | null;
  host: { platform: string; release: string; cpu: string; cpus: number };
  docker: {
    version: string;
    os: string;
    kernel: string;
    cpus: number;
    memoryGiB: number;
  } | null;
}

const run = (command: string, args: string[]): string | null => {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

const encode = (script: string): string =>
  Buffer.from(script, 'utf16le').toString('base64');

export function powershell(script: string): string | null {
  return run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encode(script),
  ]);
}

export function keepAwake(): void {
  if (process.platform === 'darwin') {
    spawn('caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
    })
      .on('error', () => undefined)
      .unref();
  } else if (process.platform === 'win32') {
    const script = [
      `$power = Add-Type -Name Power -Namespace LoadTest -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
      '[void]$power::SetThreadExecutionState(2147483649)',
      `Wait-Process -Id ${process.pid}`,
    ].join('; ');
    spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)],
      { stdio: 'ignore', windowsHide: true },
    )
      .on('error', () => undefined)
      .unref();
  }
}

export function imageId(tag: string): string | null {
  return run('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']);
}

export function provenance(image: string | null): Provenance {
  const info = run('docker', ['info', '--format', '{{json .}}']);
  const docker = info ? JSON.parse(info) : null;
  return {
    commit: run('git', ['rev-parse', '--short', 'HEAD']) ?? 'unknown',
    dirty: isDirty(),
    image,
    host: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cpus: cpus().length,
    },
    docker: docker
      ? {
          version: docker.ServerVersion,
          os: docker.OperatingSystem,
          kernel: docker.KernelVersion,
          cpus: docker.NCPU,
          memoryGiB: Number((docker.MemTotal / 1024 ** 3).toFixed(1)),
        }
      : null,
  };
}

export function isDirty(): boolean {
  return run('git', ['status', '--porcelain', '--untracked-files=no']) !== '';
}

export function cpuTicks(): { total: number; steal: number } | null {
  if (!existsSync('/proc/stat')) return null;
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const ticks = line.trim().split(/\s+/).slice(1, 9).map(Number);
  return { total: ticks.reduce((a, b) => a + b, 0), steal: ticks[7] ?? 0 };
}

export function stealPct(
  before: ReturnType<typeof cpuTicks>,
  after: ReturnType<typeof cpuTicks>,
): number | null {
  if (!before || !after || after.total <= before.total) return null;
  return (100 * (after.steal - before.steal)) / (after.total - before.total);
}
