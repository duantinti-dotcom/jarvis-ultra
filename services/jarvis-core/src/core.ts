import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceStatus, RelayCommand } from '@jarvis/contracts';
import { loadConfig, CORE_VERSION, type CoreConfig } from './config.js';
import { Db } from './db/index.js';
import { createBus } from './bus.js';
import { PermissionEngine } from './permissions/engine.js';
import { ToolRegistry } from './tools/registry.js';
import { fsTools } from './tools/builtin/fs.js';
import { systemTools } from './tools/builtin/system.js';
import { appTools } from './tools/builtin/apps.js';
import { documentTools } from './tools/builtin/documents.js';
import { webTools } from './tools/builtin/web.js';
import { browserTools, closeBrowser } from './tools/builtin/browser.js';
import { visionTools } from './tools/builtin/vision.js';
import { memoryTools } from './tools/builtin/memory.js';
import { codeTools } from './tools/builtin/code.js';
import { historyTools } from './tools/builtin/history.js';
import { inputTools } from './tools/builtin/input.js';
import { terminalTools } from './tools/builtin/terminal.js';
import { Credentials } from './security/credentials.js';
import { DEFAULT_VOICE, type VoiceSettings } from './voice/engine.js';
import { OllamaClient } from './brain/ollama.js';
import { ModelRouter } from './brain/router.js';
import { TaskStore } from './brain/tasks.js';
import { Conversations } from './brain/conversations.js';
import { Brain } from './brain/orchestrator.js';
import { MemoryStore } from './memory/store.js';
import { PluginManager } from './plugins/manager.js';
import { Lab, labTools } from './lab/lab.js';
import { VoiceEngine } from './voice/engine.js';
import { RelayClient } from './relay/client.js';
import { detectHardware, liveStats, type HardwareInfo } from './hardware/detect.js';
import { initLogFile, logger } from './log.js';
import { cpuPercent } from './hardware/detect.js';

const log = logger('core');

export class Core {
  readonly version = CORE_VERSION;
  readonly config: CoreConfig;
  readonly db: Db;
  readonly bus = createBus();
  readonly perms: PermissionEngine;
  readonly tools: ToolRegistry;
  readonly ollama: OllamaClient;
  readonly router: ModelRouter;
  readonly tasks: TaskStore;
  readonly convs: Conversations;
  readonly memory: MemoryStore;
  readonly brain: Brain;
  readonly plugins: PluginManager;
  readonly lab: Lab;
  readonly voice: VoiceEngine;
  readonly relay: RelayClient;
  readonly credentials: Credentials;
  hardware: HardwareInfo | null = null;
  readonly startedAt = Date.now();

  constructor(overrides: Partial<CoreConfig> = {}) {
    this.config = loadConfig(overrides);
    initLogFile(this.config.logDir);
    this.db = new Db(this.config.dbPath);
    this.perms = new PermissionEngine(this.db, this.bus);
    this.tools = new ToolRegistry(this.db, this.perms, this.bus, this.config);
    this.ollama = new OllamaClient(this.config.ollamaUrl);
    this.router = new ModelRouter(this.ollama, this.db);
    this.tasks = new TaskStore(this.db, this.bus);
    this.convs = new Conversations(this.db);
    this.memory = new MemoryStore(this.db, {
      model: async () => (await this.router.pick('embed'))?.model ?? null,
      embed: async (texts, kind) => {
        const m = (await this.router.pick('embed'))?.model;
        if (!m) return [];
        // Prefixos de tarefa do nomic-embed-text melhoram a recuperação.
        const pre = /nomic/i.test(m) ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
        return this.ollama.embed(m, texts.map((t) => pre + t));
      },
    });
    this.brain = new Brain(this.db, this.bus, this.ollama, this.router, this.tools, this.tasks, this.convs, this.memory, this.perms);
    this.plugins = new PluginManager(this.db, this.tools, this.config);
    this.lab = new Lab(this.db, this.bus, this.ollama, this.router, this.brain.queue, this.plugins, this.config);
    this.voice = new VoiceEngine(this.config.dataDir);
    this.credentials = new Credentials(this.db, this.config.dataDir);
    this.voice.settings = () => ({ ...DEFAULT_VOICE, ...this.db.getSetting<Partial<VoiceSettings>>('voice.settings', {}) });
    this.voice.elevenKey = () => this.credentials.get('elevenlabs.apiKey');
    this.relay = new RelayClient(this.db, this.bus, this.config.dataDir, (cmd, id) => this.handleRemote(cmd, id), () => this.deviceStatus());

    for (const t of [...fsTools, ...systemTools, ...appTools, ...documentTools, ...webTools, ...browserTools, ...visionTools(this.bus, this.ollama, this.router), ...memoryTools(this.memory), ...codeTools, ...historyTools(this.convs), ...labTools(this.lab), ...inputTools, ...terminalTools]) this.tools.register(t);
  }

  async init() {
    this.perms.expireOrphans();
    this.tasks.failOrphans();
    this.seedDefaults();
    await this.plugins.loadAll();
    this.hardware = await detectHardware(this.config.dataDir).catch(() => null);
    if (this.hardware) this.router.setHardware(this.hardware);
    const v = await this.ollama.version();
    log.info(v ? `Ollama ${v} em ${this.config.ollamaUrl}` : `Ollama não encontrado em ${this.config.ollamaUrl}`);
    this.memory.applyRetention();
    this.relay.start();
    // Pré-carrega o modelo principal para reduzir a latência da primeira resposta.
    if (v && this.db.getSetting('model.preload', true)) {
      void this.router.pick('tools').then((p) => p && this.ollama.load(p.model).then(() => log.info(`modelo ${p.model} pré-carregado`))).catch((e) => log.warn(`pré-carga falhou: ${e.message}`));
      // Embeddings aquecidos: a primeira busca de memória não paga a carga a frio (~20 s medidos em CPU).
      void this.router.pick('embed').then((p) => p && this.ollama.embed(p.model, ['aquecimento']).then(() => log.info(`embeddings ${p.model} prontos`))).catch(() => {});
    }
    return this;
  }

  /** Primeira execução: pasta de trabalho e aplicativos comuns do Windows. */
  private seedDefaults() {
    if (this.db.getSetting('seeded', false) || process.env.JARVIS_NO_SEED === '1') return;
    const docs = path.join(os.homedir(), process.platform === 'win32' ? 'Documents' : '', 'JARVIS');
    fs.mkdirSync(docs, { recursive: true });
    this.perms.addRoot(docs, 'readwrite', false);
    if (process.platform === 'win32') {
      const sys = process.env.SystemRoot ?? 'C:\\Windows';
      const edge = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      const apps: [string, string, boolean][] = [
        ['Bloco de Notas', path.join(sys, 'System32', 'notepad.exe'), true],
        ['Calculadora', 'calc.exe', true],
        ['Paint', 'mspaint.exe', true],
        ['Explorador de Arquivos', path.join(sys, 'explorer.exe'), false],
      ];
      if (fs.existsSync(edge)) apps.push(['Navegador Edge', edge, false]);
      for (const [n, p, c] of apps) this.perms.addApp(n, p, { canClose: c });
    }
    this.db.setSetting('seeded', true);
    log.info(`configuração inicial criada (pasta de trabalho: ${docs})`);
  }

  async deviceStatus(): Promise<DeviceStatus> {
    const pick = await this.router.pick('tools').catch(() => null);
    const loaded = await this.ollama.ps().catch(() => []);
    return {
      hostname: os.hostname(), platform: `${process.platform}-${process.arch}`, coreVersion: this.version,
      model: pick?.model ?? null, modelLoaded: !!pick && loaded.some((l) => l.name === pick.model), profile: this.router.profile,
      cpuPercent: cpuPercent(), ramUsedGb: Math.round(((os.totalmem() - os.freemem()) / 1073741824) * 10) / 10, ramTotalGb: Math.round((os.totalmem() / 1073741824) * 10) / 10,
      gpu: this.hardware?.gpus[0]?.name ?? null, activeTasks: this.tasks.active().length, pendingApprovals: this.perms.listApprovals('pending').length,
      remoteEnabled: this.relay.enabled, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Execução de comandos vindos do site. Tudo passa pela origem "remote" e suas permissões. */
  async handleRemote(cmd: RelayCommand, _commandId: string): Promise<unknown> {
    this.perms.audit('relay.command', 'remote', { kind: cmd.kind });
    switch (cmd.kind) {
      case 'chat': {
        const { conversationId, messageId, done } = this.brain.start({ conversationId: cmd.conversationId, text: cmd.text, origin: 'remote' });
        this.relay.trackRemote(conversationId);
        void done;
        return { conversationId, messageId };
      }
      case 'task.cancel': {
        const t = this.tasks.get(cmd.taskId);
        if (!t) throw new Error('Tarefa não encontrada.');
        this.tasks.cancel(cmd.taskId, 'Cancelada pelo site');
        return { cancelled: true };
      }
      case 'approval.respond':
        return { state: this.perms.decide(cmd.approvalId, cmd.approve, 'remote') };
      case 'status.get':
        return { status: await this.deviceStatus(), live: await liveStats() };
      case 'tasks.list':
        return { tasks: this.tasks.list(cmd.limit) };
      case 'memory.list':
        // Somente memórias marcadas como sincronizáveis saem do computador.
        return { memories: cmd.query ? (await this.memory.search(cmd.query, { limit: 20 })).results.filter((m) => m.syncable) : this.memory.list({ syncableOnly: true, limit: 100 }) };
      case 'conversations.list':
        return { conversations: this.convs.list(50).filter((c) => c.origin === 'remote' || this.db.getSetting('relay.shareLocalConversations', false)) };
      case 'conversation.get': {
        const conv = this.convs.list(500).find((c) => c.id === cmd.conversationId);
        if (!conv || (conv.origin !== 'remote' && !this.db.getSetting('relay.shareLocalConversations', false))) throw new Error('Conversa não compartilhada com o site.');
        this.relay.trackRemote(cmd.conversationId);
        return { conversation: conv, messages: this.convs.messages(cmd.conversationId, 200).filter((m) => m.role !== 'tool') };
      }
      case 'emergency.stop':
        this.perms.emergencyStop('remote');
        return { stopped: true };
    }
  }

  async shutdown() {
    this.relay.stop();
    await closeBrowser();
    this.db.close();
  }
}
