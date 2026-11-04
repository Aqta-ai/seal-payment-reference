import { DatabaseSync } from 'node:sqlite';

const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER_ID = /^[0-9a-f]{32}$/;

function workflowId(value) {
  if (typeof value !== 'string' || !WORKFLOW_ID.test(value)) throw new TypeError('Invalid workflow identifier.');
}

function ownerId(value) {
  if (typeof value !== 'string' || !OWNER_ID.test(value)) throw new TypeError('Invalid demo owner identifier.');
}

/** Explicit ownership only. Existing workflows are never claimed implicitly. */
export class DemoOwnerStore {
  #db;

  constructor({ filename = ':memory:' } = {}) {
    const db = new DatabaseSync(filename, { timeout: 5000 });
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS demo_workflow_owners (
          workflow_id TEXT PRIMARY KEY NOT NULL,
          owner_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS demo_workflow_owners_owner
          ON demo_workflow_owners (owner_id);
      `);
      this.#db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #database() {
    if (!this.#db) throw new Error('The demo ownership store is closed.');
    return this.#db;
  }

  assign(id, owner) {
    workflowId(id);
    ownerId(owner);
    const db = this.#database();
    db.prepare('INSERT INTO demo_workflow_owners (workflow_id, owner_id) VALUES (?, ?) ON CONFLICT(workflow_id) DO NOTHING').run(id, owner);
    if (db.prepare('SELECT owner_id FROM demo_workflow_owners WHERE workflow_id = ?').get(id)?.owner_id !== owner) {
      throw new Error('This workflow already belongs to another demo owner.');
    }
  }

  ownerOf(id) {
    workflowId(id);
    return this.#database().prepare('SELECT owner_id FROM demo_workflow_owners WHERE workflow_id = ?').get(id)?.owner_id ?? null;
  }

  count(owner) {
    ownerId(owner);
    return this.#database().prepare('SELECT COUNT(*) AS total FROM demo_workflow_owners WHERE owner_id = ?').get(owner).total;
  }

  workflowIds(owner, limit = 100) {
    ownerId(owner);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid workflow limit.');
    return this.#database().prepare('SELECT workflow_id FROM demo_workflow_owners WHERE owner_id = ? ORDER BY rowid DESC LIMIT ?').all(owner, limit).map(row => row.workflow_id);
  }

  close() {
    if (!this.#db) return;
    this.#db.close();
    this.#db = null;
  }
}
