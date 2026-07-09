import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker.js', import.meta.url);

export class WorkerPool {
  constructor(options = {}) {
    this.size = options.size || 1;
    this.resourceLimits = options.resourceLimits || {
      maxOldGenerationSizeMb: 32,
      maxYoungGenerationSizeMb: 4,
      stackSizeMb: 1,
    };
    this.workers = [];
    this.pending = new Map();
    this.nextId = 0;
    this._rr = 0;
    this._alive = 0;

    for (let i = 0; i < this.size; i++) this._spawn();
  }

  _spawn() {
    try {
      const worker = new Worker(WORKER_URL, { resourceLimits: this.resourceLimits, execArgv: [] });
      this._alive++;
      worker.on('message', (msg) => {
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg);
        }
      });
      worker.on('error', () => this._onExit(worker));
      worker.on('exit', () => this._onExit(worker));
      this.workers.push(worker);
      return true;
    } catch {
      return false;
    }
  }

  _onExit(dead) {
    this._alive--;
    const idx = this.workers.indexOf(dead);
    if (idx !== -1) this.workers.splice(idx, 1);
  }

  postMessage(msg, transferList) {
    return new Promise((resolve, reject) => {
      if (this._alive === 0) {
        reject(new Error('No workers available'));
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, (res) => {
        if (res.type === 'error') reject(new Error(res.error));
        else resolve(res);
      });
      const worker = this.workers[this._rr++ % this._alive];
      try {
        worker.postMessage({ ...msg, id }, transferList || []);
      } catch (err) {
        reject(err);
      }
    });
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this._alive = 0;
    this.pending.clear();
  }
}
