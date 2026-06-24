/**
 * Host system metrics for the Status role's resource monitor.
 *
 * Uses only Node built-ins (cross-platform, no native deps): os for CPU/memory/
 * uptime/load and fs.statfs for disk. CPU utilisation is a delta between samples,
 * so the first sample reads 0 and subsequent ones are accurate over the interval.
 */
import os from 'node:os';
import { statfs } from 'node:fs/promises';

export interface MetricsSnapshot {
  cpu: number; // 0..100
  memory: { pct: number; usedMB: number; totalMB: number };
  disk: { pct: number; usedGB: number; totalGB: number } | null;
  uptimeSec: number;
  load1: number; // 1-min load average (0 on Windows)
  cores: number;
  cpuModel: string;
  platform: string;
  procRssMB: number;
}

interface CpuTimes {
  idle: number;
  total: number;
}

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

export class SystemMetrics {
  private prev: CpuTimes | undefined;

  constructor(private readonly diskPath: string) {}

  async sample(): Promise<MetricsSnapshot> {
    const now = cpuTimes();
    let cpu = 0;
    if (this.prev) {
      const idleD = now.idle - this.prev.idle;
      const totalD = now.total - this.prev.total;
      cpu = totalD > 0 ? Math.max(0, Math.min(100, Math.round((1 - idleD / totalD) * 100))) : 0;
    }
    this.prev = now;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    let disk: MetricsSnapshot['disk'] = null;
    try {
      const s = await statfs(this.diskPath);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      const used = total - free;
      if (total > 0) {
        disk = { pct: Math.round((used / total) * 100), usedGB: round1(used / 1e9), totalGB: round1(total / 1e9) };
      }
    } catch {
      disk = null;
    }

    return {
      cpu,
      memory: { pct: Math.round((usedMem / totalMem) * 100), usedMB: Math.round(usedMem / 1048576), totalMB: Math.round(totalMem / 1048576) },
      disk,
      uptimeSec: Math.round(os.uptime()),
      load1: round2(os.loadavg()[0] ?? 0),
      cores: os.cpus().length,
      cpuModel: (os.cpus()[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(),
      platform: `${os.platform()} ${os.arch()}`,
      procRssMB: Math.round(process.memoryUsage().rss / 1048576),
    };
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
