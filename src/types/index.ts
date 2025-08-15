// Core type definitions for Sekai Memory System

/**
 * Predicates for memory relationships - now accepts any string
 * These define the types of relationships and facts that can be stored
 */
export type ValidPredicate = string;

/**
 * Memory types supported by the system
 */
export type MemoryType = 'C2U' | 'IC' | 'WM';

/**
 * Memory status for supersession logic
 */
export type MemoryStatus = 'active' | 'superseded' | 'duplicate';

/**
 * Entity types in the system
 */
export type EntityKind = 'character' | 'user' | 'world';

/**
 * LLM providers supported
 */
export type LLMProvider = 'openai' | 'anthropic';

/**
 * Embedding providers supported
 */
export type EmbeddingProvider = 'openai' | 'hash';

/**
 * Raw chapter data from memory_data.json
 */
export interface ChapterData {
  chapter_number: number;
  synopsis: string;
}

/**
 * Entity representation (characters, users, world)
 */
export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  created_at: Date;
}

/**
 * Structured memory extracted from LLM with validation
 */
export interface StructuredMemory {
  type: MemoryType;
  predicate: ValidPredicate;
  subjects: string[];           // entity names from LLM
  objects?: string[];           // entity names (required for IC type)
  canonical_fact: string;       // normalized fact representation
  raw_content: string;          // original extracted text
  confidence: number;           // 0-1 confidence score
  valid_from: number;           // chapter number when memory becomes valid
  valid_to?: number;            // chapter number when memory expires (null = ongoing)
}

/**
 * Persisted memory with resolved entity IDs and metadata
 */
export interface Memory extends StructuredMemory {
  id: string;
  subject_ids: string[];        // resolved entity IDs
  object_ids?: string[];        // resolved entity IDs (for IC memories)
  embedding?: number[];         // vector embedding for semantic search
  status: MemoryStatus;         // active, superseded, duplicate
  supersedes_id?: string;       // ID of memory this supersedes
  created_at: Date;
  updated_at: Date;
}

/**
 * Filter parameters for memory retrieval
 */
export interface MemoryFilter {
  type?: MemoryType[];
  characterName?: string;       // filter by character name (converted to entity ID)
  characterId?: string;         // filter by entity ID directly
  userId?: string;             // filter by user entity ID
  chapterNumber?: number;       // exact chapter
  chapterRange?: [number, number]; // chapter range [min, max]
  predicates?: ValidPredicate[];
  status?: MemoryStatus;        // default: 'active'
  validAt?: number;            // chapter number for time-gated retrieval
}

/**
 * Memory pack returned from retrieval operations
 */
export interface MemoryPack {
  memories: Memory[];
  totalCount: number;
  filtersApplied: MemoryFilter;
  query?: string;               // semantic search query if provided
  relevanceScores?: Record<string, number>; // memory ID -> relevance score
  executionTime?: number;       // query execution time in ms
}

/**
 * Context for memory retrieval operations
 */
export interface RetrievalContext {
  query?: string;               // semantic search query
  filters?: MemoryFilter;
  limit?: number;               // max results to return
  threshold?: number;           // minimum relevance score (0-1)
  includeWorldMemories?: boolean; // include WM valid at chapter
}

/**
 * Result of memory ingestion operation
 */
export interface IngestResult {
  chaptersProcessed: number;
  memoriesCreated: number;
  memoriesSuperseded: number;
  memoriesDuplicated: number;
  conflictsResolved: number;
  entitiesCreated: number;
  errors: MemoryError[];
  processingTime: number;       // total time in ms
}

/**
 * Result of extracting memories from a single chapter
 */
export interface ExtractionResult {
  chapterNumber: number;
  memoriesExtracted: StructuredMemory[];
  entitiesFound: string[];
  processingTime: number;
  llmUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Conflict detected between memories
 */
export interface MemoryConflict {
  newMemory: StructuredMemory;
  existingMemory: Memory;
  conflictType: 'duplicate' | 'contradiction';
  resolution: 'supersede' | 'skip' | 'merge';
}

/**
 * Error types for memory operations
 */
export interface MemoryError {
  type: 'validation' | 'llm_extraction' | 'database' | 'entity_resolution';
  message: string;
  details?: any;
  chapterNumber?: number;
  memoryContent?: string;
  timestamp: Date;
  retryable?: boolean;
}

/**
 * LLM extraction request
 */
export interface LLMExtractionRequest {
  chapterNumber: number;
  synopsis: string;
  maxRetries?: number;
}

/**
 * Raw LLM response structure expected from the API
 */
export interface LLMResponse {
  memories: {
    type: string;
    predicate: string;
    subjects: string[];
    objects?: string[];
    canonical_fact: string;
    raw_content: string;
    confidence: number;
  }[];
}

/**
 * Evaluation metrics for the memory system
 */
export interface EvaluationMetrics {
  consistency: {
    totalMemories: number;
    conflictingMemories: number;
    consistencyScore: number;   // 1 - (conflicts / total)
  };
  coverage: {
    chaptersProcessed: number;
    memoriesExtracted: number;
    averageMemoriesPerChapter: number;
    entitiesDiscovered: number;
  };
  performance: {
    averageIngestionTime: number; // ms per chapter
    averageRetrievalTime: number; // ms per query
    databaseSize: number;         // total memories stored
  };
  llmEvaluation?: {
    precision: number;            // relevant retrieved / total retrieved
    recall: number;               // relevant retrieved / total relevant
    semanticRelevance: number;    // average LLM relevance score
    queriesGenerated: number;     // total queries generated
    totalRetrievals: number;      // total memory retrievals performed
    avgRelevanceScore: number;    // average relevance score across all results
    evaluationTime: number;       // total time spent on LLM evaluation (ms)
  };
}


/**
 * API request/response types
 */
export interface IngestRequest {
  // No body - processes memory_data.json from file system
}

export interface MemoryRetrievalRequest {
  q?: string;                   // semantic search query
  type?: string;                // comma-separated memory types
  character?: string;           // character name
  chapter?: string;             // single chapter or range "1-5"
  predicate?: string;           // comma-separated predicates
  limit?: string;               // max results
  threshold?: string;           // minimum relevance score
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: MemoryError;
  meta?: {
    requestId: string;
    timestamp: Date;
    executionTime: number;
  };
}

/**
 * Database row interfaces for SQLite operations
 */
export interface EntityRow {
  id: string;
  name: string;
  kind: EntityKind;
  aliases: string;              // JSON stringified array
  created_at: string;           // ISO datetime string
}

export interface MemoryRow {
  id: string;
  type: MemoryType;
  predicate: ValidPredicate;
  subjects: string;             // JSON stringified array of entity IDs
  objects?: string;             // JSON stringified array of entity IDs
  canonical_fact: string;
  raw_content: string;
  confidence: number;
  valid_from: number;
  valid_to?: number;
  embedding?: string;           // JSON stringified array
  status: MemoryStatus;
  supersedes_id?: string;
  created_at: string;           // ISO datetime string
  updated_at: string;           // ISO datetime string
}

/**
 * Configuration interfaces
 */
export interface DatabaseConfig {
  path: string;
  enableWAL?: boolean;          // Write-Ahead Logging
  busyTimeout?: number;         // milliseconds
}

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature?: number;
  maxRetries?: number;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model?: string;               // only for OpenAI
  dimension: number;
}

/**
 * Utility types for type safety
 */
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
export type OptionalFields<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Type guards for runtime validation
 */
export function isValidMemoryType(type: string): type is MemoryType {
  return ['C2U', 'IC', 'WM'].includes(type);
}

export function isValidPredicate(predicate: string): predicate is ValidPredicate {
  // Accept any non-empty string as a valid predicate
  return typeof predicate === 'string' && predicate.trim().length > 0;
}

export function isValidEntityKind(kind: string): kind is EntityKind {
  return ['character', 'user', 'world'].includes(kind);
}

export function isValidMemoryStatus(status: string): status is MemoryStatus {
  return ['active', 'superseded', 'duplicate'].includes(status);
}

/**
 * Constants
 */
export const DEFAULT_USER_ID = 'user-default';
export const DEFAULT_WORLD_ID = 'world-default';
export const MAX_MEMORY_CONTENT_LENGTH = 1000;
export const MIN_CONFIDENCE_SCORE = 0.1;
export const DEFAULT_RETRIEVAL_LIMIT = 50;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

/**
 * LLM-generated query for evaluation
 */
export interface LLMGeneratedQuery {
  query: string;                // the search query
  queryType: 'entity' | 'relationship' | 'event' | 'temporal' | 'general';
  expectedContext: string;      // what kind of results should be relevant
  chapterNumber: number;        // source chapter
  confidence: number;           // query generation confidence (0-1)
}

/**
 * LLM evaluation of a retrieved memory
 */
export interface LLMMemoryEvaluation {
  memoryId: string;
  relevanceScore: number;       // 0-1 relevance to the query
  reasoning: string;            // explanation of the score
  isRelevant: boolean;          // binary relevance decision
}

/**
 * LLM evaluation result for a single query
 */
export interface LLMQueryEvaluation {
  query: LLMGeneratedQuery;
  retrievedMemories: Memory[];
  evaluations: LLMMemoryEvaluation[];
  precision: number;            // relevant results / total results
  recall: number;               // relevant results / expected relevant
  avgRelevanceScore: number;    // average relevance score
  executionTime: number;        // time to evaluate this query (ms)
}

/**
 * Complete LLM evaluation results
 */
export interface LLMEvaluationResult {
  chapterEvaluations: LLMQueryEvaluation[];
  overallPrecision: number;
  overallRecall: number;
  overallSemanticRelevance: number;
  totalQueriesGenerated: number;
  totalRetrievals: number;
  avgRelevanceScore: number;
  totalEvaluationTime: number;
}