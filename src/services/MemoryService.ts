import { LLMExtractor } from './LLMExtractor';
import { MemoryStore } from '../storage/MemoryStore';
import { MemoryUpdateReporter, getMemoryReporter } from './MemoryUpdateReporter';
import {
  ChapterData,
  StructuredMemory,
  Memory,
  MemoryPack,
  IngestResult,
  MemoryError,
  RetrievalContext,
  LLMExtractionRequest,
  DEFAULT_RETRIEVAL_LIMIT,
  DEFAULT_SIMILARITY_THRESHOLD
} from '../types';
import {
  calculateEnhancedRelevanceScore,
  generateQueryEmbedding,
  generateMemoryEmbedding,
  findSimilarMemories
} from '../utils/similarity';

export class MemoryService {
  private llmExtractor: LLMExtractor;
  private memoryStore: MemoryStore;

  constructor(llmExtractor: LLMExtractor, memoryStore: MemoryStore) {
    this.llmExtractor = llmExtractor;
    this.memoryStore = memoryStore;
  }

  /**
   * Ingest a single chapter with LLM extraction and storage
   */
  public async ingestChapter(chapter: ChapterData): Promise<IngestResult> {
    const startTime = Date.now();
    const errors: MemoryError[] = [];
    let memoriesCreated = 0;
    let memoriesSuperseded = 0;
    let memoriesDuplicated = 0;
    let conflictsResolved = 0;
    let entitiesCreated = 0;

    try {
      console.log(`Processing chapter ${chapter.chapter_number}...`);

      // Extract memories using LLM
      const extractionRequest: LLMExtractionRequest = {
        chapterNumber: chapter.chapter_number,
        synopsis: chapter.synopsis
      };

      const extractionResult = await this.llmExtractor.extractMemories(extractionRequest);
      
      if (extractionResult.memoriesExtracted.length === 0) {
        console.warn(`No memories extracted from chapter ${chapter.chapter_number}`);
        return {
          chaptersProcessed: 1,
          memoriesCreated: 0,
          memoriesSuperseded: 0,
          memoriesDuplicated: 0,
          conflictsResolved: 0,
          entitiesCreated: 0,
          errors: [],
          processingTime: Date.now() - startTime
        };
      }

      console.log(`Extracted ${extractionResult.memoriesExtracted.length} memories from chapter ${chapter.chapter_number}`);

      // Process each extracted memory
      for (const structuredMemory of extractionResult.memoriesExtracted) {
        try {
          // Generate embedding for the memory
          const embedding = generateMemoryEmbedding(structuredMemory);

          // Count entities before processing
          const entitiesBefore = await this.getEntityCount();

          // Process memory with conflict resolution
          const result = await this.memoryStore.processMemoryWithConflictResolution(structuredMemory);

          // Update the stored memory with embedding
          if (result.action === 'created') {
            await this.updateMemoryEmbedding(result.memoryId, embedding);
          }

          // Count entities after processing
          const entitiesAfter = await this.getEntityCount();
          entitiesCreated += entitiesAfter - entitiesBefore;

          // Update counters based on action
          switch (result.action) {
            case 'created':
              memoriesCreated++;
              break;
            case 'superseded':
              memoriesSuperseded++;
              conflictsResolved++;
              break;
            case 'duplicate':
              memoriesDuplicated++;
              break;
          }

        } catch (error) {
          const memoryError: MemoryError = {
            type: 'database',
            message: error instanceof Error ? error.message : 'Unknown error processing memory',
            details: structuredMemory,
            chapterNumber: chapter.chapter_number,
            memoryContent: structuredMemory.canonical_fact,
            timestamp: new Date()
          };
          errors.push(memoryError);
          console.error(`Error processing memory: ${memoryError.message}`);
        }
      }

      const processingTime = Date.now() - startTime;
      console.log(`Chapter ${chapter.chapter_number} processed in ${processingTime}ms`);

      return {
        chaptersProcessed: 1,
        memoriesCreated,
        memoriesSuperseded,
        memoriesDuplicated,
        conflictsResolved,
        entitiesCreated,
        errors,
        processingTime
      };

    } catch (error) {
      const ingestionError: MemoryError = {
        type: 'llm_extraction',
        message: error instanceof Error ? error.message : 'Unknown error during chapter ingestion',
        chapterNumber: chapter.chapter_number,
        timestamp: new Date()
      };
      errors.push(ingestionError);

      return {
        chaptersProcessed: 1,
        memoriesCreated: 0,
        memoriesSuperseded: 0,
        memoriesDuplicated: 0,
        conflictsResolved: 0,
        entitiesCreated: 0,
        errors,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Retrieve memories with filtering, ranking, and semantic search
   */
  public async retrieveMemories(
    context: RetrievalContext = {}
  ): Promise<MemoryPack> {
    const startTime = Date.now();
    const {
      query,
      filters = {},
      limit = DEFAULT_RETRIEVAL_LIMIT,
      threshold = DEFAULT_SIMILARITY_THRESHOLD,
      includeWorldMemories = true
    } = context;

    try {
      // Resolve character name to ID if provided
      if (filters.characterName) {
        const entity = await this.memoryStore.getEntityByNameOrAlias(filters.characterName);
        if (entity) {
          filters.characterId = entity.id;
        } else {
          console.warn(`Character not found: ${filters.characterName}`);
        }
        delete filters.characterName; // Remove to avoid confusion in MemoryStore
      }

      // Get base memories with filters
      let memories = await this.memoryStore.getMemories(filters);

      // Include relevant world memories if requested
      if (includeWorldMemories && filters.chapterNumber) {
        const worldMemories = await this.memoryStore.getActiveMemoriesAtChapter(
          filters.chapterNumber,
          { type: ['WM'], status: 'active' }
        );
        memories = [...memories, ...worldMemories];
      }

      // If no query provided, sort by recency and confidence
      if (!query) {
        memories.sort((a, b) => {
          const recencyDiff = b.valid_from - a.valid_from;
          if (recencyDiff !== 0) return recencyDiff;
          return b.confidence - a.confidence;
        });

        const limitedMemories = memories.slice(0, limit);
        
        return {
          memories: limitedMemories,
          totalCount: memories.length,
          filtersApplied: filters,
          executionTime: Date.now() - startTime
        };
      }

      // Semantic search with query
      const queryEmbedding = generateQueryEmbedding(query);
      
      // Extract entities from query for enhanced scoring
      const queryEntities = this.extractEntitiesFromQuery(query);
      
      // Calculate relevance scores
      const scoredMemories = memories
        .map(memory => {
          if (!memory.embedding) {
            // Generate embedding if missing
            memory.embedding = generateMemoryEmbedding(memory);
          }

          const scoringOptions: any = {
            queryEmbedding,
            queryEntities
          };
          
          if (filters.chapterNumber || filters.validAt) {
            scoringOptions.currentChapter = filters.chapterNumber || filters.validAt;
          }
          
          if (filters.type) {
            scoringOptions.preferredTypes = filters.type;
          }
          
          const relevanceScore = calculateEnhancedRelevanceScore(memory, scoringOptions);

          return {
            memory,
            score: relevanceScore
          };
        })
        .filter(item => item.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const relevanceScores: Record<string, number> = {};
      scoredMemories.forEach(item => {
        relevanceScores[item.memory.id] = item.score;
      });

      return {
        memories: scoredMemories.map(item => item.memory),
        totalCount: memories.length,
        filtersApplied: filters,
        query,
        relevanceScores,
        executionTime: Date.now() - startTime
      };

    } catch (error) {
      console.error('Error retrieving memories:', error);
      
      const result: MemoryPack = {
        memories: [],
        totalCount: 0,
        filtersApplied: filters,
        executionTime: Date.now() - startTime
      };
      
      if (query) {
        result.query = query;
      }
      
      return result;
    }
  }

  /**
   * Supersede duplicates based on conflict resolution logic
   */
  public async supersedeDuplicates(memory: StructuredMemory): Promise<void> {
    try {
      // This is now handled by the MemoryStore.processMemoryWithConflictResolution
      // This method exists for backward compatibility and explicit supersession
      const conflicts = await this.memoryStore.findConflicting(memory);
      
      if (conflicts.length > 0) {
        console.log(`Found ${conflicts.length} conflicting memories for supersession`);
        
        for (const conflict of conflicts) {
          if (conflict.canonical_fact !== memory.canonical_fact) {
            await this.memoryStore.supersedeMemory(conflict.id, memory);
            console.log(`Superseded memory ${conflict.id} with new memory`);
          }
        }
      }
    } catch (error) {
      console.error('Error superseding duplicates:', error);
      throw error;
    }
  }

  /**
   * Get memory statistics for monitoring
   */
  public async getMemoryStatistics(): Promise<{
    totalMemories: number;
    activeMemories: number;
    supersededMemories: number;
    duplicateMemories: number;
    memoriesByType: Record<string, number>;
    memoriesByStatus: Record<string, number>;
    entityCount: number;
  }> {
    try {
      const allMemories = await this.memoryStore.getMemories({});
      const totalMemories = allMemories.length;
      
      const activeMemories = allMemories.filter(m => m.status === 'active').length;
      const supersededMemories = allMemories.filter(m => m.status === 'superseded').length;
      const duplicateMemories = allMemories.filter(m => m.status === 'duplicate').length;
      
      const memoriesByType: Record<string, number> = {};
      const memoriesByStatus: Record<string, number> = {};
      
      allMemories.forEach(memory => {
        memoriesByType[memory.type] = (memoriesByType[memory.type] || 0) + 1;
        memoriesByStatus[memory.status] = (memoriesByStatus[memory.status] || 0) + 1;
      });
      
      const entityCount = await this.getEntityCount();
      
      return {
        totalMemories,
        activeMemories,
        supersededMemories,
        duplicateMemories,
        memoriesByType,
        memoriesByStatus,
        entityCount
      };
    } catch (error) {
      console.error('Error getting memory statistics:', error);
      throw error;
    }
  }

  /**
   * Search for memories similar to a given memory
   */
  public async findSimilarMemories(
    targetMemory: Memory,
    options: {
      limit?: number;
      threshold?: number;
      excludeSelf?: boolean;
    } = {}
  ): Promise<Array<{ memory: Memory; score: number; similarity: number }>> {
    const { limit = 10, threshold = 0.3, excludeSelf = true } = options;
    
    if (!targetMemory.embedding) {
      targetMemory.embedding = generateMemoryEmbedding(targetMemory);
    }
    
    const allMemories = await this.memoryStore.getMemories({ status: 'active' });
    const candidateMemories = excludeSelf 
      ? allMemories.filter(m => m.id !== targetMemory.id)
      : allMemories;
    
    return findSimilarMemories(targetMemory.embedding, candidateMemories, {
      limit,
      threshold,
      currentChapter: targetMemory.valid_from
    });
  }

  /**
   * Update memory embedding (for when embedding is generated after storage)
   */
  private async updateMemoryEmbedding(memoryId: string, embedding: number[]): Promise<void> {
    try {
      await this.memoryStore.updateMemoryEmbedding(memoryId, embedding);
    } catch (error) {
      console.error('Error updating memory embedding:', error);
      throw error;
    }
  }

  /**
   * Get total entity count
   */
  private async getEntityCount(): Promise<number> {
    try {
      const characters = await this.memoryStore.getEntitiesByKind('character');
      const users = await this.memoryStore.getEntitiesByKind('user');
      const worlds = await this.memoryStore.getEntitiesByKind('world');
      return characters.length + users.length + worlds.length;
    } catch (error) {
      console.error('Error getting entity count:', error);
      return 0;
    }
  }

  /**
   * Extract potential entity names from a query string
   */
  private extractEntitiesFromQuery(query: string): string[] {
    // Simple extraction - look for capitalized words that might be names
    const words = query.split(/\s+/);
    const entities: string[] = [];
    
    for (const word of words) {
      // Look for capitalized words (potential names)
      if (/^[A-Z][a-z]+$/.test(word)) {
        entities.push(word);
      }
    }
    
    // Also check for common pronouns and terms
    const entityTerms = ['user', 'player', 'world', 'environment'];
    for (const term of entityTerms) {
      if (query.toLowerCase().includes(term)) {
        entities.push(term);
      }
    }
    
    return Array.from(new Set(entities)); // Remove duplicates
  }

  /**
   * Batch ingest multiple chapters
   */
  public async ingestChapters(chapters: ChapterData[], verbose: boolean = false, generateReport: boolean = false): Promise<IngestResult> {
    const startTime = Date.now();
    const aggregateResult: IngestResult = {
      chaptersProcessed: 0,
      memoriesCreated: 0,
      memoriesSuperseded: 0,
      memoriesDuplicated: 0,
      conflictsResolved: 0,
      entitiesCreated: 0,
      errors: [],
      processingTime: 0
    };

    // Initialize reporter if requested
    let reporter: MemoryUpdateReporter | null = null;
    if (generateReport) {
      reporter = getMemoryReporter();
      reporter.startIngestionTracking();
    }

    // Get initial state if verbose reporting
    let initialStats: any = null;
    if (verbose || generateReport) {
      initialStats = await this.getMemoryStatistics();
      if (verbose) {
        console.log('\n📊 Initial Memory Store State:');
        console.log(`   Total Memories: ${initialStats.totalMemories} (${initialStats.activeMemories} active)`);
        console.log(`   Total Entities: ${initialStats.entityCount}`);
        console.log(`   Memory Types: ${JSON.stringify(initialStats.memoriesByType)}`);
        console.log('─'.repeat(60));
      }
    }

    for (const chapter of chapters) {
      try {
        // Get pre-chapter stats if verbose or reporting
        const preStats = (verbose || generateReport) ? await this.getMemoryStatistics() : null;
        
        // Start chapter tracking if reporter is active
        if (reporter && preStats) {
          reporter.startChapterTracking(chapter.chapter_number, {
            totalMemories: preStats.totalMemories,
            activeMemories: preStats.activeMemories,
            supersededMemories: preStats.supersededMemories,
            totalEntities: preStats.entityCount
          });
        }
        
        // Process chapter with reporter integration
        const chapterResult = await this.ingestChapterWithReporting(chapter, reporter);
        
        // Aggregate results
        aggregateResult.chaptersProcessed += chapterResult.chaptersProcessed;
        aggregateResult.memoriesCreated += chapterResult.memoriesCreated;
        aggregateResult.memoriesSuperseded += chapterResult.memoriesSuperseded;
        aggregateResult.memoriesDuplicated += chapterResult.memoriesDuplicated;
        aggregateResult.conflictsResolved += chapterResult.conflictsResolved;
        aggregateResult.entitiesCreated += chapterResult.entitiesCreated;
        aggregateResult.errors.push(...chapterResult.errors);
        
        // Get post-chapter stats
        const postStats = (verbose || generateReport) ? await this.getMemoryStatistics() : null;
        
        // Complete chapter tracking if reporter is active
        if (reporter && postStats) {
          const extractionResult = await this.llmExtractor.extractMemories({
            chapterNumber: chapter.chapter_number,
            synopsis: chapter.synopsis
          });
          
          reporter.completeChapterTracking(
            extractionResult.memoriesExtracted.length,
            {
              totalMemories: postStats.totalMemories,
              activeMemories: postStats.activeMemories,
              supersededMemories: postStats.supersededMemories,
              totalEntities: postStats.entityCount
            },
            chapterResult
          );
        }
        
        // Report chapter changes if verbose
        if (verbose && preStats && postStats) {
          await this.reportChapterChanges(chapter.chapter_number, preStats, postStats, chapterResult);
        }
        
      } catch (error) {
        const chapterError: MemoryError = {
          type: 'llm_extraction',
          message: `Failed to process chapter ${chapter.chapter_number}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          chapterNumber: chapter.chapter_number,
          timestamp: new Date()
        };
        aggregateResult.errors.push(chapterError);
      }
    }

    aggregateResult.processingTime = Date.now() - startTime;
    
    // Complete report generation if active
    if (reporter) {
      await reporter.completeIngestionTracking();
    }
    
    // Final summary if verbose
    if (verbose && initialStats) {
      const finalStats = await this.getMemoryStatistics();
      console.log('\n' + '═'.repeat(60));
      console.log('📊 Final Memory Store State:');
      console.log(`   Total Memories: ${finalStats.totalMemories} (+${finalStats.totalMemories - initialStats.totalMemories})`);
      console.log(`   Active Memories: ${finalStats.activeMemories} (+${finalStats.activeMemories - initialStats.activeMemories})`);
      console.log(`   Superseded: ${finalStats.supersededMemories} (+${finalStats.supersededMemories - initialStats.supersededMemories})`);
      console.log(`   Total Entities: ${finalStats.entityCount} (+${finalStats.entityCount - initialStats.entityCount})`);
      console.log(`   Processing Time: ${(aggregateResult.processingTime / 1000).toFixed(1)}s`);
      console.log('═'.repeat(60));
    }
    
    return aggregateResult;
  }

  /**
   * Ingest a single chapter with reporting integration
   */
  private async ingestChapterWithReporting(chapter: ChapterData, reporter: MemoryUpdateReporter | null): Promise<IngestResult> {
    const startTime = Date.now();
    const errors: MemoryError[] = [];
    let memoriesCreated = 0;
    let memoriesSuperseded = 0;
    let memoriesDuplicated = 0;
    let conflictsResolved = 0;
    let entitiesCreated = 0;

    try {
      console.log(`Processing chapter ${chapter.chapter_number}...`);

      // Extract memories using LLM
      const extractionRequest: LLMExtractionRequest = {
        chapterNumber: chapter.chapter_number,
        synopsis: chapter.synopsis
      };

      const extractionResult = await this.llmExtractor.extractMemories(extractionRequest);
      
      if (extractionResult.memoriesExtracted.length === 0) {
        console.warn(`No memories extracted from chapter ${chapter.chapter_number}`);
        return {
          chaptersProcessed: 1,
          memoriesCreated: 0,
          memoriesSuperseded: 0,
          memoriesDuplicated: 0,
          conflictsResolved: 0,
          entitiesCreated: 0,
          errors: [],
          processingTime: Date.now() - startTime
        };
      }

      console.log(`Extracted ${extractionResult.memoriesExtracted.length} memories from chapter ${chapter.chapter_number}`);

      // Process each extracted memory
      for (const structuredMemory of extractionResult.memoriesExtracted) {
        try {
          // Generate embedding for the memory
          const embedding = generateMemoryEmbedding(structuredMemory);

          // Count entities before processing
          const entitiesBefore = await this.getEntityCount();

          // Track entity creation if reporter is active
          if (reporter) {
            // Track new entities that will be created
            for (const entityName of [...structuredMemory.subjects, ...(structuredMemory.objects || [])]) {
              const existing = await this.memoryStore.getEntityByNameOrAlias(entityName);
              if (!existing) {
                reporter.trackEntityChange('created', {
                  name: entityName,
                  kind: 'character'
                });
              }
            }
          }

          // Process memory with conflict resolution
          const result = await this.memoryStore.processMemoryWithConflictResolution(structuredMemory);

          // Track memory change if reporter is active
          if (reporter) {
            if (result.action === 'superseded') {
              // Get the superseded memory for reporting
              const conflictingMemories = await this.memoryStore.findConflicting(structuredMemory);
              const supersededMemory = conflictingMemories.find(m => m.canonical_fact !== structuredMemory.canonical_fact);
              reporter.trackMemoryChange('superseded', structuredMemory, result.memoryId, supersededMemory);
            } else {
              reporter.trackMemoryChange(result.action, structuredMemory, result.memoryId);
            }
          }

          // Update the stored memory with embedding
          if (result.action === 'created') {
            await this.updateMemoryEmbedding(result.memoryId, embedding);
          }

          // Count entities after processing
          const entitiesAfter = await this.getEntityCount();
          entitiesCreated += entitiesAfter - entitiesBefore;

          // Update counters based on action
          switch (result.action) {
            case 'created':
              memoriesCreated++;
              break;
            case 'superseded':
              memoriesSuperseded++;
              conflictsResolved++;
              break;
            case 'duplicate':
              memoriesDuplicated++;
              break;
          }

        } catch (error) {
          const memoryError: MemoryError = {
            type: 'database',
            message: error instanceof Error ? error.message : 'Unknown error processing memory',
            details: structuredMemory,
            chapterNumber: chapter.chapter_number,
            memoryContent: structuredMemory.canonical_fact,
            timestamp: new Date()
          };
          errors.push(memoryError);
          
          // Track error if reporter is active
          if (reporter) {
            reporter.trackError(memoryError.message);
          }
          
          console.error(`Error processing memory: ${memoryError.message}`);
        }
      }

      const processingTime = Date.now() - startTime;
      console.log(`Chapter ${chapter.chapter_number} processed in ${processingTime}ms`);

      return {
        chaptersProcessed: 1,
        memoriesCreated,
        memoriesSuperseded,
        memoriesDuplicated,
        conflictsResolved,
        entitiesCreated,
        errors,
        processingTime
      };

    } catch (error) {
      const chapterError: MemoryError = {
        type: 'llm_extraction',
        message: error instanceof Error ? error.message : 'Unknown error',
        chapterNumber: chapter.chapter_number,
        timestamp: new Date()
      };
      errors.push(chapterError);
      
      // Track error if reporter is active
      if (reporter) {
        reporter.trackError(chapterError.message);
      }

      console.error(`Failed to process chapter ${chapter.chapter_number}:`, error);
      
      return {
        chaptersProcessed: 0,
        memoriesCreated: 0,
        memoriesSuperseded: 0,
        memoriesDuplicated: 0,
        conflictsResolved: 0,
        entitiesCreated: 0,
        errors,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Report detailed changes from chapter processing
   */
  private async reportChapterChanges(
    chapterNum: number,
    preStats: any,
    postStats: any,
    result: IngestResult
  ): Promise<void> {
    console.log(`\n📖 Chapter ${chapterNum} Processing Report:`);
    console.log('   Changes:');
    
    // Memory changes
    if (result.memoriesCreated > 0) {
      console.log(`     ✅ Created: ${result.memoriesCreated} new memories`);
    }
    if (result.memoriesSuperseded > 0) {
      console.log(`     🔄 Superseded: ${result.memoriesSuperseded} conflicting memories`);
    }
    if (result.memoriesDuplicated > 0) {
      console.log(`     ⏭️  Skipped: ${result.memoriesDuplicated} duplicate memories`);
    }
    
    // Entity changes
    const entityDiff = postStats.entityCount - preStats.entityCount;
    if (entityDiff > 0) {
      console.log(`     👤 New Entities: ${entityDiff} discovered`);
      
      // Show new entity names if available
      try {
        const recentEntities = await this.memoryStore.getEntitiesByKind('character');
        const newEntities = recentEntities.slice(-entityDiff);
        if (newEntities.length > 0) {
          console.log(`        Names: ${newEntities.map(e => e.name).join(', ')}`);
        }
      } catch (e) {
        // Ignore errors in reporting
      }
    }
    
    // Memory store state
    console.log('   Current Store:');
    console.log(`     Total: ${postStats.totalMemories} memories (Δ${postStats.totalMemories - preStats.totalMemories})`);
    console.log(`     Active: ${postStats.activeMemories} (Δ${postStats.activeMemories - preStats.activeMemories})`);
    
    // Type distribution changes
    const typeChanges: string[] = [];
    for (const type of ['C2U', 'IC', 'WM']) {
      const pre = preStats.memoriesByType[type] || 0;
      const post = postStats.memoriesByType[type] || 0;
      if (post > pre) {
        typeChanges.push(`${type}: +${post - pre}`);
      }
    }
    if (typeChanges.length > 0) {
      console.log(`     Types: ${typeChanges.join(', ')}`);
    }
    
    // Show example of new memories if any created
    if (result.memoriesCreated > 0) {
      try {
        const recentMemories = await this.memoryStore.getMemories({ 
          chapterNumber: chapterNum,
          status: 'active'
        });
        if (recentMemories.length > 0) {
          console.log('   Sample Memory:');
          const sample = recentMemories[0];
          console.log(`     "${sample.canonical_fact}"`);
        }
      } catch (e) {
        // Ignore errors in reporting
      }
    }
    
    console.log('─'.repeat(60));
  }

  /**
   * Create a MemoryService instance from configuration
   */
  public static fromConfig(): MemoryService {
    const llmExtractor = LLMExtractor.fromConfig();
    const memoryStore = new MemoryStore();
    return new MemoryService(llmExtractor, memoryStore);
  }
}