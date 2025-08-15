import * as sqlite3 from 'sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

export class DatabaseManager {
  private db: sqlite3.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'memories.db');
    this.ensureDirectoryExists();
    this.db = new sqlite3.Database(this.dbPath);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
  }

  private ensureDirectoryExists(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  public async initialize(): Promise<void> {
    await this.createTables();
    await this.createIndexes();
    await this.createViews();
    await this.seedDefaultData();
  }

  private async createTables(): Promise<void> {
    const runAsync = promisify(this.db.run.bind(this.db));

    // Create entities table for characters, users, and world entities
    await runAsync(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT CHECK(kind IN ('character','user','world')) NOT NULL,
        aliases TEXT, -- JSON array of alternate names
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create memories table with predicates, time bounds, and supersession
    await runAsync(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT CHECK(type IN ('C2U', 'IC', 'WM')) NOT NULL,
        predicate TEXT NOT NULL,
        subjects TEXT NOT NULL,     -- JSON array of entity IDs
        objects TEXT,               -- JSON array of entity IDs (for IC)
        canonical_fact TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        valid_from INTEGER NOT NULL,  -- chapter number
        valid_to INTEGER,            -- chapter number (null = ongoing)
        embedding TEXT,              -- JSON stringified array
        status TEXT CHECK(status IN ('active','superseded','duplicate')) DEFAULT 'active',
        supersedes_id TEXT,          -- ID of memory this supersedes
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (supersedes_id) REFERENCES memories(id)
      )
    `);
  }

  private async createIndexes(): Promise<void> {
    const runAsync = promisify(this.db.run.bind(this.db));

    // Indexes for fast retrieval
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)',
      'CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)',
      'CREATE INDEX IF NOT EXISTS idx_memories_valid_range ON memories(valid_from, valid_to)',
      'CREATE INDEX IF NOT EXISTS idx_memories_predicate ON memories(predicate)',
      'CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)',
      'CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind)',
      'CREATE INDEX IF NOT EXISTS idx_memories_subjects ON memories(subjects)',
      'CREATE INDEX IF NOT EXISTS idx_memories_objects ON memories(objects)'
    ];

    for (const indexSql of indexes) {
      await runAsync(indexSql);
    }
  }

  private async createViews(): Promise<void> {
    const runAsync = promisify(this.db.run.bind(this.db));

    // View for active characters
    await runAsync(`
      CREATE VIEW IF NOT EXISTS characters AS 
      SELECT * FROM entities WHERE kind = 'character'
    `);

    // View for active memories (not superseded or duplicates)
    await runAsync(`
      CREATE VIEW IF NOT EXISTS active_memories AS
      SELECT * FROM memories WHERE status = 'active'
    `);
  }

  private async seedDefaultData(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if User entity already exists
      this.db.get('SELECT COUNT(*) as count FROM entities WHERE name = ?', ['User'], (err, row: any) => {
        if (err) {
          reject(err);
          return;
        }
        
        const userExists = row as { count: number };
        
        if (userExists.count === 0) {
          // Create default User entity for C2U memories
          this.db.run(`
            INSERT INTO entities (id, name, kind, aliases)
            VALUES (?, ?, ?, ?)
          `, ['user-default', 'User', 'user', JSON.stringify(['Player', 'Human'])], (err) => {
            if (err) {
              reject(err);
              return;
            }
            
            // Check if World entity already exists
            this.db.get('SELECT COUNT(*) as count FROM entities WHERE name = ?', ['World'], (err, row: any) => {
              if (err) {
                reject(err);
                return;
              }
              
              const worldExists = row as { count: number };
              
              if (worldExists.count === 0) {
                // Create default World entity for WM memories
                this.db.run(`
                  INSERT INTO entities (id, name, kind, aliases)
                  VALUES (?, ?, ?, ?)
                `, ['world-default', 'World', 'world', JSON.stringify(['Environment', 'Setting'])], (err) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve();
                  }
                });
              } else {
                resolve();
              }
            });
          });
        } else {
          // Check if World entity already exists
          this.db.get('SELECT COUNT(*) as count FROM entities WHERE name = ?', ['World'], (err, row: any) => {
            if (err) {
              reject(err);
              return;
            }
            
            const worldExists = row as { count: number };
            
            if (worldExists.count === 0) {
              // Create default World entity for WM memories
              this.db.run(`
                INSERT INTO entities (id, name, kind, aliases)
                VALUES (?, ?, ?, ?)
              `, ['world-default', 'World', 'world', JSON.stringify(['Environment', 'Setting'])], (err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  public getDatabase(): sqlite3.Database {
    return this.db;
  }

  public close(): void {
    this.db.close();
  }

  public async resetDatabase(): Promise<void> {
    const runAsync = promisify(this.db.run.bind(this.db));
    await runAsync('DROP TABLE IF EXISTS memories');
    await runAsync('DROP TABLE IF EXISTS entities');
    await runAsync('DROP VIEW IF EXISTS characters');
    await runAsync('DROP VIEW IF EXISTS active_memories');
    await this.initialize();
  }

  public async getDatabaseInfo(): Promise<{ path: string; size: number; tableCount: number }> {
    return new Promise((resolve, reject) => {
      const stats = fs.statSync(this.dbPath);
      this.db.get("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'", [], (err, row: any) => {
        if (err) {
          reject(err);
          return;
        }
        
        const tables = row as { count: number };
        resolve({
          path: this.dbPath,
          size: stats.size,
          tableCount: tables.count
        });
      });
    });
  }
}

// Singleton instance for application use
let dbManager: DatabaseManager | null = null;

export async function initializeDatabase(dbPath?: string): Promise<DatabaseManager> {
  if (!dbManager) {
    dbManager = new DatabaseManager(dbPath);
    await dbManager.initialize();
  }
  return dbManager;
}

export function getDatabase(): sqlite3.Database {
  if (!dbManager) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbManager.getDatabase();
}

export function getDatabaseManager(): DatabaseManager {
  if (!dbManager) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbManager;
}

export function closeDatabaseConnection(): void {
  if (dbManager) {
    dbManager.close();
    dbManager = null;
  }
}