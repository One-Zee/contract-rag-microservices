// Where a load run's numbers come from: the commit and image under test, the
// machine Docker runs on, and how much CPU the hypervisor took away while the
// run lasted. Recorded with every run, so a table can name its machine and a
// mixed series cannot pass for one.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { REPO_ROOT } from '../lib/paths.ts';

export interface Provenance {
  commit: string;
  /** Tracked files differ from the commit: the numbers are not reproducible from it. */
  dirty: boolean;
  /** The image the containers ran, by content — a rebuild from other sources changes it. */
  image: string | null;
  /** The machine the orchestrator and k6's results came from. */
  host: { platform: string; release: string; cpu: string; cpus: number };
  /** What Docker sees — on macOS the VM, not the Mac. */
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

/** Tracked files differ from HEAD — or there is no git to ask, which counts the same. */
export function isDirty(): boolean {
  return run('git', ['status', '--porcelain', '--untracked-files=no']) !== '';
}

/**
 * The machine-wide CPU counters of /proc/stat, in clock ticks — Linux only.
 * Steal is time a virtual CPU was ready to run and the hypervisor ran someone
 * else: on shared cores a neighbour's load shows up here, and in latency.
 */
export function cpuTicks(): { total: number; steal: number } | null {
  if (!existsSync('/proc/stat')) return null;
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
  // user nice system idle iowait irq softirq steal [guest guest_nice]: the
  // guest columns are already inside user and nice.
  const ticks = line.trim().split(/\s+/).slice(1, 9).map(Number);
  return { total: ticks.reduce((a, b) => a + b, 0), steal: ticks[7] ?? 0 };
}

/** Steal as a share of all CPU time between two readings, in percent. */
export function stealPct(
  before: ReturnType<typeof cpuTicks>,
  after: ReturnType<typeof cpuTicks>,
): number | null {
  if (!before || !after || after.total <= before.total) return null;
  return (100 * (after.steal - before.steal)) / (after.total - before.total);
}
