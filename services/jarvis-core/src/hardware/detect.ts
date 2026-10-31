import os from 'node:os';
import fs from 'node:fs';
import { run, powershell } from '../util/proc.js';

export type GpuInfo = { name: string; vramTotalMb: number | null; vramUsedMb: number | null; utilPercent: number | null; vendor: 'nvidia' | 'amd' | 'intel' | 'other'; cuda: boolean };
export type HardwareInfo = {
  hostname: string; platform: string; arch: string;
  cpu: { model: string; cores: number; threads: number };
  ramTotalGb: number; ramFreeGb: number;
  gpus: GpuInfo[];
  diskFreeGb: number | null;
  detectedAt: string;
};

export async function detectGpus(): Promise<GpuInfo[]> {
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 5000 }).catch(() => null);
  if (nv && nv.code === 0 && nv.stdout.trim()) {
    return nv.stdout.trim().split(/\r?\n/).map((l) => {
      const [name, total, used, util] = l.split(',').map((x) => x.trim());
      return { name: name ?? 'NVIDIA GPU', vramTotalMb: num(total), vramUsedMb: num(used), utilPercent: num(util), vendor: 'nvidia' as const, cuda: true };
    });
  }
  if (process.platform === 'win32') {
    const r = await powershell('Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress');
    if (r.code === 0 && r.stdout.trim()) {
      const parsed = JSON.parse(r.stdout);
      const arr: { Name: string; AdapterRAM: number | null }[] = Array.isArray(parsed) ? parsed : [parsed];
      return arr.map((g) => ({
        name: g.Name, vramTotalMb: g.AdapterRAM ? Math.round(g.AdapterRAM / 1048576) : null, vramUsedMb: null, utilPercent: null,
        vendor: /nvidia/i.test(g.Name) ? 'nvidia' : /amd|radeon/i.test(g.Name) ? 'amd' : /intel/i.test(g.Name) ? 'intel' : 'other', cuda: false,
      }));
    }
  }
  return [];
}

export async function detectHardware(dataDir: string): Promise<HardwareInfo> {
  const cpus = os.cpus();
  let diskFreeGb: number | null = null;
  try {
    const st = fs.statfsSync(dataDir);
    diskFreeGb = round((st.bavail * st.bsize) / 1e9);
  } catch {}
  return {
    hostname: os.hostname(), platform: process.platform, arch: process.arch,
    cpu: { model: cpus[0]?.model.trim() ?? 'desconhecido', cores: Math.max(1, Math.round(cpus.length / 2)), threads: cpus.length },
    ramTotalGb: round(os.totalmem() / 1073741824), ramFreeGb: round(os.freemem() / 1073741824),
    gpus: await detectGpus(), diskFreeGb, detectedAt: new Date().toISOString(),
  };
}

let last = os.cpus().map((c) => c.times);
/** Uso de CPU desde a última chamada (amostragem por diferença). */
export function cpuPercent(): number {
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = last[i] ?? t;
    const dIdle = t.idle - p.idle;
    const dTotal = t.user + t.nice + t.sys + t.irq + t.idle - (p.user + p.nice + p.sys + p.irq + p.idle);
    idle += dIdle;
    total += dTotal;
  });
  last = now;
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

export async function liveStats() {
  const gpus = await detectGpus();
  const mem = process.memoryUsage();
  return {
    cpuPercent: cpuPercent(),
    ramTotalGb: round(os.totalmem() / 1073741824),
    ramUsedGb: round((os.totalmem() - os.freemem()) / 1073741824),
    gpus,
    jarvis: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
    uptimeSec: Math.round(process.uptime()),
    loadAvg: os.loadavg(),
    at: new Date().toISOString(),
  };
}

const num = (v: string | undefined) => (v && !Number.isNaN(Number(v)) ? Number(v) : null);
const round = (n: number) => Math.round(n * 10) / 10;
