import {
  MemoryType,
  StructuredMemory,
  Entity,
  MemoryFilter,
  MIN_CONFIDENCE_SCORE,
  MAX_MEMORY_CONTENT_LENGTH,
  isValidMemoryType,
  isValidPredicate,
  isValidEntityKind,
  isValidMemoryStatus
} from '../types';

/**
 * Validation utilities for memory system types
 */

export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public value?: any
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate structured memory from LLM extraction
 */
export function validateStructuredMemory(memory: any): StructuredMemory {
  const errors: string[] = [];

  // Validate type
  if (!memory.type || !isValidMemoryType(memory.type)) {
    errors.push(`Invalid memory type: ${memory.type}. Must be C2U, IC, or WM`);
  }

  // Validate predicate
  if (!memory.predicate || !isValidPredicate(memory.predicate)) {
    errors.push(`Invalid predicate: ${memory.predicate}`);
  }

  // Validate subjects
  if (!Array.isArray(memory.subjects) || memory.subjects.length === 0) {
    errors.push('Subjects must be a non-empty array');
  }

  // Validate objects for IC memories
  if (memory.type === 'IC') {
    if (!Array.isArray(memory.objects) || memory.objects.length === 0) {
      errors.push('Objects are required for IC (Inter-Character) memories');
    }
  }

  // Validate canonical_fact
  if (!memory.canonical_fact || typeof memory.canonical_fact !== 'string') {
    errors.push('canonical_fact is required and must be a string');
  }

  // Validate raw_content
  if (!memory.raw_content || typeof memory.raw_content !== 'string') {
    errors.push('raw_content is required and must be a string');
  }

  // Validate content length
  if (memory.raw_content && memory.raw_content.length > MAX_MEMORY_CONTENT_LENGTH) {
    errors.push(`raw_content exceeds maximum length of ${MAX_MEMORY_CONTENT_LENGTH}`);
  }

  // Validate confidence
  if (typeof memory.confidence !== 'number' || 
      memory.confidence < MIN_CONFIDENCE_SCORE || 
      memory.confidence > 1) {
    errors.push(`confidence must be a number between ${MIN_CONFIDENCE_SCORE} and 1`);
  }

  // Validate valid_from
  if (typeof memory.valid_from !== 'number' || memory.valid_from < 1) {
    errors.push('valid_from must be a positive number (chapter number)');
  }

  // Validate valid_to if provided
  if (memory.valid_to !== undefined && 
      (typeof memory.valid_to !== 'number' || memory.valid_to < memory.valid_from)) {
    errors.push('valid_to must be a number >= valid_from');
  }

  if (errors.length > 0) {
    throw new ValidationError(`Memory validation failed: ${errors.join(', ')}`);
  }

  return memory as StructuredMemory;
}

/**
 * Validate entity data
 */
export function validateEntity(entity: any): Entity {
  const errors: string[] = [];

  if (!entity.id || typeof entity.id !== 'string') {
    errors.push('id is required and must be a string');
  }

  if (!entity.name || typeof entity.name !== 'string') {
    errors.push('name is required and must be a string');
  }

  if (!entity.kind || !isValidEntityKind(entity.kind)) {
    errors.push(`Invalid entity kind: ${entity.kind}. Must be character, user, or world`);
  }

  if (!Array.isArray(entity.aliases)) {
    errors.push('aliases must be an array');
  }

  if (errors.length > 0) {
    throw new ValidationError(`Entity validation failed: ${errors.join(', ')}`);
  }

  return entity as Entity;
}

/**
 * Validate memory filter parameters
 */
export function validateMemoryFilter(filter: any): MemoryFilter {
  const validated: MemoryFilter = {};

  if (filter.type) {
    if (Array.isArray(filter.type)) {
      const invalidTypes = filter.type.filter((t: any) => !isValidMemoryType(t));
      if (invalidTypes.length > 0) {
        throw new ValidationError(`Invalid memory types: ${invalidTypes.join(', ')}`);
      }
      validated.type = filter.type;
    } else {
      throw new ValidationError('type filter must be an array');
    }
  }

  if (filter.characterName && typeof filter.characterName === 'string') {
    validated.characterName = filter.characterName;
  }

  if (filter.characterId && typeof filter.characterId === 'string') {
    validated.characterId = filter.characterId;
  }

  if (filter.userId && typeof filter.userId === 'string') {
    validated.userId = filter.userId;
  }

  if (filter.chapterNumber && typeof filter.chapterNumber === 'number') {
    validated.chapterNumber = filter.chapterNumber;
  }

  if (filter.chapterRange) {
    if (Array.isArray(filter.chapterRange) && 
        filter.chapterRange.length === 2 &&
        typeof filter.chapterRange[0] === 'number' &&
        typeof filter.chapterRange[1] === 'number' &&
        filter.chapterRange[0] <= filter.chapterRange[1]) {
      validated.chapterRange = filter.chapterRange as [number, number];
    } else {
      throw new ValidationError('chapterRange must be [min, max] where min <= max');
    }
  }

  if (filter.predicates) {
    if (Array.isArray(filter.predicates)) {
      const invalidPredicates = filter.predicates.filter((p: any) => !isValidPredicate(p));
      if (invalidPredicates.length > 0) {
        throw new ValidationError(`Invalid predicates: ${invalidPredicates.join(', ')}`);
      }
      validated.predicates = filter.predicates;
    } else {
      throw new ValidationError('predicates filter must be an array');
    }
  }

  if (filter.status && isValidMemoryStatus(filter.status)) {
    validated.status = filter.status;
  }

  if (filter.validAt && typeof filter.validAt === 'number') {
    validated.validAt = filter.validAt;
  }

  return validated;
}

/**
 * Sanitize and normalize entity names
 */
export function normalizeEntityName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gi, '') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();
}

/**
 * Generate canonical fact representation for memory comparison
 */
export function generateCanonicalFact(memory: StructuredMemory): string {
  const subjects = memory.subjects.map(normalizeEntityName).sort().join(',');
  const objects = memory.objects ? memory.objects.map(normalizeEntityName).sort().join(',') : '';
  
  return `${memory.type}:${memory.predicate}:${subjects}${objects ? ':' + objects : ''}`;
}

/**
 * Validate chapter number range
 */
export function validateChapterNumber(chapter: number): void {
  if (!Number.isInteger(chapter) || chapter < 1) {
    throw new ValidationError('Chapter number must be a positive integer');
  }
}

/**
 * Parse chapter range string (e.g., "1-5" or "3")
 */
export function parseChapterRange(range: string): [number, number] | number {
  const trimmed = range.trim();
  
  if (trimmed.includes('-')) {
    const [start, end] = trimmed.split('-').map(s => parseInt(s.trim(), 10));
    if (isNaN(start) || isNaN(end) || start > end || start < 1) {
      throw new ValidationError('Invalid chapter range format. Use "1-5" or single number');
    }
    return [start, end];
  } else {
    const chapter = parseInt(trimmed, 10);
    if (isNaN(chapter) || chapter < 1) {
      throw new ValidationError('Invalid chapter number');
    }
    return chapter;
  }
}

/**
 * Validate confidence score
 */
export function validateConfidence(confidence: number): void {
  if (typeof confidence !== 'number' || 
      confidence < MIN_CONFIDENCE_SCORE || 
      confidence > 1) {
    throw new ValidationError(
      `Confidence must be between ${MIN_CONFIDENCE_SCORE} and 1, got ${confidence}`
    );
  }
}

/**
 * Check if memory types are compatible for comparison
 */
export function areMemoryTypesCompatible(type1: MemoryType, type2: MemoryType): boolean {
  return type1 === type2;
}

/**
 * Validate embedding vector
 */
export function validateEmbedding(embedding: number[], expectedDimension: number): void {
  if (!Array.isArray(embedding)) {
    throw new ValidationError('Embedding must be an array');
  }
  
  if (embedding.length !== expectedDimension) {
    throw new ValidationError(
      `Embedding dimension mismatch. Expected ${expectedDimension}, got ${embedding.length}`
    );
  }
  
  if (!embedding.every(val => typeof val === 'number' && isFinite(val))) {
    throw new ValidationError('Embedding must contain only finite numbers');
  }
}

/**
 * Enhanced error handling utilities
 */

// HTTP status codes mapping
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
} as const;

// Error categorization
export function categorizeError(error: any): {
  status: number;
  type: 'validation' | 'llm_extraction' | 'database' | 'entity_resolution';
  isRetryable: boolean;
} {
  if (error instanceof ValidationError) {
    return {
      status: HTTP_STATUS.BAD_REQUEST,
      type: 'validation',
      isRetryable: false
    };
  }
  
  if (error.message?.includes('OPENAI_API_KEY') || error.message?.includes('LLM')) {
    return {
      status: HTTP_STATUS.BAD_GATEWAY,
      type: 'llm_extraction',
      isRetryable: true
    };
  }
  
  if (error.message?.includes('database') || error.message?.includes('SQLITE')) {
    return {
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      type: 'database',
      isRetryable: true
    };
  }
  
  if (error.message?.includes('entity') || error.message?.includes('resolve')) {
    return {
      status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
      type: 'entity_resolution',
      isRetryable: false
    };
  }
  
  // Default for unknown errors
  return {
    status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    type: 'database',
    isRetryable: false
  };
}

/**
 * Enhanced request validation for API endpoints
 */
export function validateIngestionRequest(body: any, files?: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // If no body or files, expect memory_data.json in filesystem
  if (!body && !files) {
    return { isValid: true, errors: [] }; // Will check filesystem
  }
  
  // If body provided, validate chapter array
  if (body && Array.isArray(body)) {
    if (body.length === 0) {
      errors.push('Chapter array cannot be empty');
    }
    
    if (body.length > 1000) {
      errors.push('Cannot process more than 1000 chapters at once');
    }
    
    // Validate each chapter
    body.forEach((chapter, index) => {
      try {
        validateChapterData(chapter);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown validation error';
        errors.push(`Chapter ${index + 1}: ${errorMessage}`);
      }
    });
    
    // Check for duplicate chapter numbers
    const chapterNumbers = body.map((ch: any) => ch.chapter_number).filter(Boolean);
    const duplicates = chapterNumbers.filter((num: number, index: number) => 
      chapterNumbers.indexOf(num) !== index
    );
    
    if (duplicates.length > 0) {
      errors.push(`Duplicate chapter numbers: ${[...new Set(duplicates)].join(', ')}`);
    }
  }
  
  return { isValid: errors.length === 0, errors };
}

function validateChapterData(chapter: any): void {
  if (!chapter || typeof chapter !== 'object') {
    throw new ValidationError('Chapter must be an object');
  }
  
  if (!chapter.chapter_number || !Number.isInteger(chapter.chapter_number) || chapter.chapter_number < 1) {
    throw new ValidationError('chapter_number must be a positive integer');
  }
  
  if (chapter.chapter_number > 10000) {
    throw new ValidationError('chapter_number cannot exceed 10000');
  }
  
  if (!chapter.synopsis || typeof chapter.synopsis !== 'string') {
    throw new ValidationError('synopsis must be a non-empty string');
  }
  
  if (chapter.synopsis.trim().length < 10) {
    throw new ValidationError('synopsis must be at least 10 characters long');
  }
  
  if (chapter.synopsis.length > 50000) {
    throw new ValidationError('synopsis cannot exceed 50000 characters');
  }
}

/**
 * Enhanced memory retrieval validation
 */
export function validateRetrievalRequest(query: any): { 
  isValid: boolean; 
  errors: string[]; 
  sanitized: any; 
} {
  const errors: string[] = [];
  const sanitized: any = {};
  
  // Validate and sanitize query parameter
  if (query.q !== undefined) {
    if (typeof query.q !== 'string') {
      errors.push('Query parameter "q" must be a string');
    } else if (query.q.trim().length === 0) {
      errors.push('Query parameter "q" cannot be empty');
    } else if (query.q.length > 1000) {
      errors.push('Query parameter "q" cannot exceed 1000 characters');
    } else {
      // Sanitize query - remove potentially harmful characters
      sanitized.q = query.q.trim().replace(/[<>]/g, '').substring(0, 500);
    }
  }
  
  // Validate type parameter
  if (query.type !== undefined) {
    if (typeof query.type !== 'string') {
      errors.push('Type parameter must be a string');
    } else {
      const types = query.type.split(',').map((t: string) => t.trim());
      const validTypes = ['C2U', 'IC', 'WM'];
      const invalidTypes = types.filter((t: string) => !validTypes.includes(t));
      
      if (invalidTypes.length > 0) {
        errors.push(`Invalid memory types: ${invalidTypes.join(', ')}. Must be one of: ${validTypes.join(', ')}`);
      } else {
        sanitized.type = types;
      }
    }
  }
  
  // Validate character parameter
  if (query.character !== undefined) {
    if (typeof query.character !== 'string') {
      errors.push('Character parameter must be a string');
    } else if (query.character.trim().length === 0) {
      errors.push('Character parameter cannot be empty');
    } else if (query.character.length > 100) {
      errors.push('Character name cannot exceed 100 characters');
    } else if (!/^[a-zA-Z\s'-]+$/.test(query.character)) {
      errors.push('Character name contains invalid characters');
    } else {
      sanitized.characterName = query.character.trim();
    }
  }
  
  // Validate chapter parameter
  if (query.chapter !== undefined) {
    if (typeof query.chapter !== 'string') {
      errors.push('Chapter parameter must be a string');
    } else {
      try {
        const chapterValue = parseChapterRange(query.chapter);
        if (Array.isArray(chapterValue)) {
          const [start, end] = chapterValue;
          if (end - start > 1000) {
            errors.push('Chapter range cannot exceed 1000 chapters');
          } else {
            sanitized.chapterRange = chapterValue;
          }
        } else {
          if (chapterValue > 10000) {
            errors.push('Chapter number cannot exceed 10000');
          } else {
            sanitized.chapterNumber = chapterValue;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Invalid chapter format';
        errors.push(`Invalid chapter parameter: ${errorMessage}`);
      }
    }
  }
  
  // Validate limit parameter
  if (query.limit !== undefined) {
    const limit = parseInt(query.limit);
    if (isNaN(limit) || limit < 1) {
      errors.push('Limit must be a positive integer');
    } else if (limit > 1000) {
      errors.push('Limit cannot exceed 1000');
    } else {
      sanitized.limit = limit;
    }
  }
  
  // Validate threshold parameter
  if (query.threshold !== undefined) {
    const threshold = parseFloat(query.threshold);
    if (isNaN(threshold) || threshold < 0 || threshold > 1) {
      errors.push('Threshold must be a number between 0 and 1');
    } else {
      sanitized.threshold = threshold;
    }
  }
  
  return { isValid: errors.length === 0, errors, sanitized };
}

/**
 * File validation utilities
 */
export function validateMemoryDataFile(filePath: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  const fs = require('fs');
  const path = require('path');
  
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      errors.push(`Memory data file not found: ${filePath}`);
      return { isValid: false, errors };
    }
    
    // Check file extension
    if (path.extname(filePath) !== '.json') {
      errors.push('Memory data file must have .json extension');
    }
    
    // Check file size (max 100MB)
    const stats = fs.statSync(filePath);
    const maxSize = 100 * 1024 * 1024; // 100MB
    
    if (stats.size > maxSize) {
      errors.push('Memory data file is too large (max 100MB)');
    }
    
    if (stats.size === 0) {
      errors.push('Memory data file is empty');
    }
    
    // Try to parse JSON
    const content = fs.readFileSync(filePath, 'utf-8');
    try {
      const data = JSON.parse(content);
      const validation = validateIngestionRequest(data);
      errors.push(...validation.errors);
    } catch (parseError) {
      const errorMessage = parseError instanceof Error ? parseError.message : 'JSON parse error';
      errors.push(`Invalid JSON format: ${errorMessage}`);
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown file system error';
    errors.push(`File system error: ${errorMessage}`);
  }
  
  return { isValid: errors.length === 0, errors };
}

/**
 * Request rate limiting and abuse prevention
 */
export function validateRequestRate(ip: string, endpoint: string, storage: Map<string, any>): {
  allowed: boolean;
  resetTime: number;
  remaining: number;
} {
  const now = Date.now();
  const key = `${ip}:${endpoint}`;
  const windowMs = endpoint === 'ingest' ? 15 * 60 * 1000 : 60 * 1000; // 15min for ingest, 1min for others
  const maxRequests = endpoint === 'ingest' ? 5 : 100;
  
  let requestData = storage.get(key);
  
  if (!requestData || now - requestData.windowStart > windowMs) {
    requestData = {
      windowStart: now,
      requests: 0
    };
  }
  
  requestData.requests++;
  storage.set(key, requestData);
  
  const allowed = requestData.requests <= maxRequests;
  const resetTime = requestData.windowStart + windowMs;
  const remaining = Math.max(0, maxRequests - requestData.requests);
  
  return { allowed, resetTime, remaining };
}