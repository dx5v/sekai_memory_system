import * as sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from './database';
import {
  Memory,
  StructuredMemory,
  Entity,
  MemoryFilter,
  MemoryRow,
  EntityRow,
  EntityKind,
  DEFAULT_USER_ID,
  DEFAULT_WORLD_ID
} from '../types';

export class MemoryStore {
  private db: sqlite3.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Save a structured memory to the database
   * Includes entity resolution and ID generation
   */
  public async saveMemory(memory: StructuredMemory): Promise<string> {
    const memoryId = uuidv4();
    
    // Resolve entity IDs for subjects
    const subjectIds = await this.resolveEntities(memory.subjects, 'character');
    
    // Resolve entity IDs for objects (if any)
    let objectIds: string[] | undefined;
    if (memory.objects && memory.objects.length > 0) {
      objectIds = await this.resolveEntities(memory.objects, 'character');
    }

    const now = new Date().toISOString();
    
    return new Promise((resolve, reject) => {
      this.db.run(`
        INSERT INTO memories (
          id, type, predicate, subjects, objects, canonical_fact, 
          raw_content, confidence, valid_from, valid_to, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        memoryId,
        memory.type,
        memory.predicate,
        JSON.stringify(subjectIds),
        objectIds ? JSON.stringify(objectIds) : null,
        memory.canonical_fact,
        memory.raw_content,
        memory.confidence,
        memory.valid_from,
        memory.valid_to || null,
        'active',
        now,
        now
      ], function(err) {
        if (err) {
          reject(new Error(`Failed to save memory: ${err.message}`));
        } else {
          resolve(memoryId);
        }
      });
    });
  }

  /**
   * Retrieve memories based on filter criteria
   */
  public async getMemories(filter: MemoryFilter = {}): Promise<Memory[]> {
    const { whereClause, params } = this.buildWhereClause(filter);
    
    const query = `
      SELECT * FROM memories 
      ${whereClause}
      ORDER BY created_at DESC
    `;

    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows: MemoryRow[]) => {
        if (err) {
          reject(new Error(`Failed to retrieve memories: ${err.message}`));
        } else {
          try {
            const memories = rows.map(row => this.mapRowToMemory(row));
            resolve(memories);
          } catch (mapError) {
            reject(new Error(`Failed to map memory rows: ${mapError instanceof Error ? mapError.message : 'Unknown error'}`));
          }
        }
      });
    });
  }

  /**
   * Update an existing memory
   */
  public async updateMemory(memoryId: string, updates: Partial<StructuredMemory>): Promise<void> {
    const setClause = [];
    const params: any[] = [];

    if (updates.canonical_fact !== undefined) {
      setClause.push('canonical_fact = ?');
      params.push(updates.canonical_fact);
    }
    
    if (updates.raw_content !== undefined) {
      setClause.push('raw_content = ?');
      params.push(updates.raw_content);
    }
    
    if (updates.confidence !== undefined) {
      setClause.push('confidence = ?');
      params.push(updates.confidence);
    }
    
    if (updates.valid_from !== undefined) {
      setClause.push('valid_from = ?');
      params.push(updates.valid_from);
    }
    
    if (updates.valid_to !== undefined) {
      setClause.push('valid_to = ?');
      params.push(updates.valid_to);
    }

    if (setClause.length === 0) {
      return; // No updates to apply
    }

    setClause.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(memoryId);

    const query = `UPDATE memories SET ${setClause.join(', ')} WHERE id = ?`;

    return new Promise((resolve, reject) => {
      this.db.run(query, params, function(err) {
        if (err) {
          reject(new Error(`Failed to update memory: ${err.message}`));
        } else if (this.changes === 0) {
          reject(new Error(`Memory with ID ${memoryId} not found`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Update the embedding for a specific memory
   */
  public async updateMemoryEmbedding(memoryId: string, embedding: number[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(`
        UPDATE memories 
        SET embedding = ?, updated_at = ?
        WHERE id = ?
      `, [JSON.stringify(embedding), new Date().toISOString(), memoryId], function(err) {
        if (err) {
          reject(new Error(`Failed to update memory embedding: ${err.message}`));
        } else if (this.changes === 0) {
          reject(new Error(`Memory with ID ${memoryId} not found`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get a specific memory by ID
   */
  public async getMemoryById(memoryId: string): Promise<Memory | null> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM memories WHERE id = ?', [memoryId], (err, row: MemoryRow) => {
        if (err) {
          reject(new Error(`Failed to get memory: ${err.message}`));
        } else if (!row) {
          resolve(null);
        } else {
          try {
            resolve(this.mapRowToMemory(row));
          } catch (mapError) {
            reject(new Error(`Failed to map memory row: ${mapError instanceof Error ? mapError.message : 'Unknown error'}`));
          }
        }
      });
    });
  }

  /**
   * Resolve entity names to IDs, creating entities if they don't exist
   */
  public async resolveEntities(entityNames: string[], defaultKind: EntityKind = 'character'): Promise<string[]> {
    const resolvedIds: string[] = [];
    
    for (const name of entityNames) {
      const entityId = await this.resolveEntity(name, defaultKind);
      resolvedIds.push(entityId);
    }
    
    return resolvedIds;
  }

  /**
   * Resolve a single entity name to ID, creating if it doesn't exist
   */
  public async resolveEntity(entityName: string, defaultKind: EntityKind = 'character'): Promise<string> {
    // Handle special cases
    if (entityName.toLowerCase() === 'user' || entityName.toLowerCase() === 'player') {
      return DEFAULT_USER_ID;
    }
    
    if (entityName.toLowerCase() === 'world' || entityName.toLowerCase() === 'environment') {
      return DEFAULT_WORLD_ID;
    }

    // Check if entity exists by name or alias
    const existingEntity = await this.getEntityByNameOrAlias(entityName);
    if (existingEntity) {
      return existingEntity.id;
    }

    // Create new entity
    const entityId = uuidv4();
    const normalizedName = this.normalizeEntityName(entityName);
    
    return new Promise((resolve, reject) => {
      this.db.run(`
        INSERT INTO entities (id, name, kind, aliases, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [
        entityId,
        normalizedName,
        defaultKind,
        JSON.stringify([entityName]), // Store original name as alias
        new Date().toISOString()
      ], (err) => {
        if (err) {
          // Handle potential race condition where entity was created by another process
          if (err.message.includes('UNIQUE constraint failed')) {
            // Try to get the entity again
            this.getEntityByNameOrAlias(entityName).then(entity => {
              if (entity) {
                resolve(entity.id);
              } else {
                reject(new Error(`Failed to resolve entity after constraint failure: ${entityName}`));
              }
            }).catch(getErr => {
              reject(new Error(`Failed to resolve entity after constraint failure: ${getErr.message}`));
            });
          } else {
            reject(new Error(`Failed to create entity: ${err.message}`));
          }
        } else {
          resolve(entityId);
        }
      });
    });
  }

  /**
   * Get entity by name or alias
   */
  public async getEntityByNameOrAlias(nameOrAlias: string): Promise<Entity | null> {
    const normalizedName = this.normalizeEntityName(nameOrAlias);
    
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT * FROM entities 
        WHERE name = ? OR aliases LIKE ?
      `, [normalizedName, `%"${nameOrAlias}"%`], (err, row: EntityRow) => {
        if (err) {
          reject(new Error(`Failed to get entity: ${err.message}`));
        } else if (!row) {
          resolve(null);
        } else {
          try {
            resolve(this.mapRowToEntity(row));
          } catch (mapError) {
            reject(new Error(`Failed to map entity row: ${mapError instanceof Error ? mapError.message : 'Unknown error'}`));
          }
        }
      });
    });
  }

  /**
   * Get all entities of a specific kind
   */
  public async getEntitiesByKind(kind: EntityKind): Promise<Entity[]> {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM entities WHERE kind = ? ORDER BY name', [kind], (err, rows: EntityRow[]) => {
        if (err) {
          reject(new Error(`Failed to get entities: ${err.message}`));
        } else {
          try {
            const entities = rows.map(row => this.mapRowToEntity(row));
            resolve(entities);
          } catch (mapError) {
            reject(new Error(`Failed to map entity rows: ${mapError instanceof Error ? mapError.message : 'Unknown error'}`));
          }
        }
      });
    });
  }

  /**
   * Find conflicting memories based on type, predicate, subjects, and objects
   * Used for conflict detection and supersession logic
   */
  public async findConflicting(memory: StructuredMemory): Promise<Memory[]> {
    // Resolve entity IDs for comparison
    const subjectIds = await this.resolveEntities(memory.subjects, 'character');
    let objectIds: string[] | undefined;
    if (memory.objects && memory.objects.length > 0) {
      objectIds = await this.resolveEntities(memory.objects, 'character');
    }

    const subjectsJson = JSON.stringify(subjectIds.sort());
    const objectsJson = objectIds ? JSON.stringify(objectIds.sort()) : null;

    return new Promise((resolve, reject) => {
      let query = `
        SELECT * FROM memories 
        WHERE type = ? AND predicate = ? AND subjects = ? AND status = 'active'
      `;
      const params: any[] = [memory.type, memory.predicate, subjectsJson];

      // Add objects condition if applicable
      if (objectsJson !== null) {
        query += ' AND objects = ?';
        params.push(objectsJson);
      } else {
        query += ' AND objects IS NULL';
      }

      this.db.all(query, params, (err, rows: MemoryRow[]) => {
        if (err) {
          reject(new Error(`Failed to find conflicting memories: ${err.message}`));
        } else {
          try {
            const memories = rows.map(row => this.mapRowToMemory(row));
            resolve(memories);
          } catch (mapError) {
            reject(new Error(`Failed to map conflicting memory rows: ${mapError instanceof Error ? mapError.message : 'Unknown error'}`));
          }
        }
      });
    });
  }

  /**
   * Supersede an existing memory with a new one
   * Sets the old memory's valid_to date and marks it as superseded
   */
  public async supersedeMemory(oldMemoryId: string, newMemory: StructuredMemory): Promise<string> {
    const newMemoryId = uuidv4();
    const now = new Date().toISOString();

    // Resolve entity IDs for the new memory
    const subjectIds = await this.resolveEntities(newMemory.subjects, 'character');
    let objectIds: string[] | undefined;
    if (newMemory.objects && newMemory.objects.length > 0) {
      objectIds = await this.resolveEntities(newMemory.objects, 'character');
    }

    return new Promise((resolve, reject) => {
      // Start a transaction-like operation by running updates sequentially
      
      // First, update the old memory to set valid_to and mark as superseded
      const endChapter = Math.max(1, newMemory.valid_from - 1);
      
      this.db.run(`
        UPDATE memories 
        SET valid_to = ?, status = 'superseded', updated_at = ?
        WHERE id = ?
      `, [endChapter, now, oldMemoryId], (updateErr) => {
        if (updateErr) {
          reject(new Error(`Failed to supersede old memory: ${updateErr.message}`));
          return;
        }

        // Then, insert the new memory with supersedes_id reference
        this.db.run(`
          INSERT INTO memories (
            id, type, predicate, subjects, objects, canonical_fact, 
            raw_content, confidence, valid_from, valid_to, status, 
            supersedes_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          newMemoryId,
          newMemory.type,
          newMemory.predicate,
          JSON.stringify(subjectIds),
          objectIds ? JSON.stringify(objectIds) : null,
          newMemory.canonical_fact,
          newMemory.raw_content,
          newMemory.confidence,
          newMemory.valid_from,
          newMemory.valid_to || null,
          'active',
          oldMemoryId,
          now,
          now
        ], (insertErr) => {
          if (insertErr) {
            // Rollback the supersession if insert fails
            this.db.run(`
              UPDATE memories 
              SET valid_to = NULL, status = 'active', updated_at = ?
              WHERE id = ?
            `, [now, oldMemoryId], () => {
              // Ignore rollback errors, focus on original error
              reject(new Error(`Failed to insert new memory: ${insertErr.message}`));
            });
          } else {
            resolve(newMemoryId);
          }
        });
      });
    });
  }

  /**
   * Get active memories that are valid at a specific chapter
   * Respects time bounds: valid_from <= chapter AND (valid_to IS NULL OR valid_to >= chapter)
   */
  public async getActiveMemoriesAtChapter(chapter: number, filter: Omit<MemoryFilter, 'chapterNumber' | 'chapterRange' | 'validAt'> = {}): Promise<Memory[]> {
    const extendedFilter: MemoryFilter = {
      ...filter,
      validAt: chapter,
      status: 'active'
    };

    return this.getMemories(extendedFilter);
  }

  /**
   * Check if a new memory is a duplicate of existing memories
   * Returns true if an identical canonical_fact exists for the same entities
   */
  public async isDuplicate(memory: StructuredMemory): Promise<boolean> {
    const conflictingMemories = await this.findConflicting(memory);
    
    return conflictingMemories.some(existing => 
      existing.canonical_fact === memory.canonical_fact
    );
  }

  /**
   * Process a new memory with conflict resolution
   * Returns: { memoryId: string, action: 'created' | 'superseded' | 'duplicate' }
   */
  public async processMemoryWithConflictResolution(memory: StructuredMemory): Promise<{ memoryId: string; action: 'created' | 'superseded' | 'duplicate' }> {
    // Check for conflicts
    const conflictingMemories = await this.findConflicting(memory);
    
    if (conflictingMemories.length === 0) {
      // No conflicts, save normally
      const memoryId = await this.saveMemory(memory);
      return { memoryId, action: 'created' };
    }

    // Check for exact duplicates
    const isDupe = conflictingMemories.some(existing => 
      existing.canonical_fact === memory.canonical_fact
    );

    if (isDupe) {
      // Return the ID of the existing duplicate
      const duplicate = conflictingMemories.find(existing => 
        existing.canonical_fact === memory.canonical_fact
      )!;
      return { memoryId: duplicate.id, action: 'duplicate' };
    }

    // Supersede the most recent conflicting memory
    const mostRecent = conflictingMemories.reduce((latest, current) => 
      new Date(current.created_at) > new Date(latest.created_at) ? current : latest
    );

    const memoryId = await this.supersedeMemory(mostRecent.id, memory);
    return { memoryId, action: 'superseded' };
  }

  /**
   * Get the supersession chain for a memory (what it supersedes and what supersedes it)
   */
  public async getSupersessionChain(memoryId: string): Promise<{ supersedes: Memory[], supersededBy: Memory[] }> {
    const supersedes: Memory[] = [];
    const supersededBy: Memory[] = [];

    // Find what this memory supersedes (walk backwards)
    let currentMemory = await this.getMemoryById(memoryId);
    while (currentMemory?.supersedes_id) {
      const supersededMemory = await this.getMemoryById(currentMemory.supersedes_id);
      if (supersededMemory) {
        supersedes.push(supersededMemory);
        currentMemory = supersededMemory;
      } else {
        break;
      }
    }

    // Find what supersedes this memory (walk forwards)
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM memories WHERE supersedes_id = ? ORDER BY created_at ASC',
        [memoryId],
        (err, rows: MemoryRow[]) => {
          if (err) {
            reject(new Error(`Failed to get supersession chain: ${err.message}`));
          } else {
            try {
              const memories = rows.map(row => this.mapRowToMemory(row));
              supersededBy.push(...memories);
              resolve({ supersedes: supersedes.reverse(), supersededBy });
            } catch (mapError) {
              reject(new Error(`Failed to map supersession chain: ${mapError instanceof Error ? mapError.message : 'Unknown error'}`));
            }
          }
        }
      );
    });
  }

  /**
   * Build WHERE clause for memory filtering
   */
  private buildWhereClause(filter: MemoryFilter): { whereClause: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];

    // Default to active status unless specified
    const status = filter.status || 'active';
    conditions.push('status = ?');
    params.push(status);

    if (filter.type && filter.type.length > 0) {
      const typeConditions = filter.type.map(() => 'type = ?').join(' OR ');
      conditions.push(`(${typeConditions})`);
      params.push(...filter.type);
    }

    if (filter.characterId) {
      conditions.push('(subjects LIKE ? OR objects LIKE ?)');
      params.push(`%"${filter.characterId}"%`, `%"${filter.characterId}"%`);
    }

    if (filter.predicates && filter.predicates.length > 0) {
      const predicateConditions = filter.predicates.map(() => 'predicate = ?').join(' OR ');
      conditions.push(`(${predicateConditions})`);
      params.push(...filter.predicates);
    }

    if (filter.chapterNumber !== undefined) {
      conditions.push('valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)');
      params.push(filter.chapterNumber, filter.chapterNumber);
    }

    if (filter.chapterRange) {
      const [minChapter, maxChapter] = filter.chapterRange;
      conditions.push('valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)');
      params.push(maxChapter, minChapter);
    }

    if (filter.validAt !== undefined) {
      conditions.push('valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)');
      params.push(filter.validAt, filter.validAt);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereClause, params };
  }

  /**
   * Map database row to Memory object
   */
  private mapRowToMemory(row: MemoryRow): Memory {
    const memory: Memory = {
      id: row.id,
      type: row.type,
      predicate: row.predicate,
      subjects: JSON.parse(row.subjects || '[]'),
      canonical_fact: row.canonical_fact,
      raw_content: row.raw_content,
      confidence: row.confidence,
      valid_from: row.valid_from,
      subject_ids: JSON.parse(row.subjects || '[]'),
      status: row.status,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at || row.created_at)
    };

    if (row.objects) {
      memory.objects = JSON.parse(row.objects);
      memory.object_ids = JSON.parse(row.objects);
    }

    if (row.valid_to) {
      memory.valid_to = row.valid_to;
    }

    if (row.embedding) {
      memory.embedding = JSON.parse(row.embedding);
    }

    if (row.supersedes_id) {
      memory.supersedes_id = row.supersedes_id;
    }

    return memory;
  }

  /**
   * Map database row to Entity object
   */
  private mapRowToEntity(row: EntityRow): Entity {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      aliases: JSON.parse(row.aliases || '[]'),
      created_at: new Date(row.created_at)
    };
  }

  /**
   * Normalize entity names for consistent storage
   */
  private normalizeEntityName(name: string): string {
    return name.trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }
}