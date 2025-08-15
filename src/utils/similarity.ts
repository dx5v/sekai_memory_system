import * as crypto from 'crypto';
import { Memory } from '../types';

/**
 * Similarity calculation utilities for memory retrieval and ranking
 */

/**
 * Generate a simple hash-based embedding for demo purposes
 * In production, this would be replaced with actual OpenAI embeddings
 */
export function generateHashEmbedding(text: string, dimension: number = 256): number[] {
  // Normalize the text
  const normalizedText = text.toLowerCase().trim();
  
  // Create multiple hash variants to fill the dimension
  const embedding: number[] = [];
  const numHashes = Math.ceil(dimension / 8); // Each hash produces 8 values
  
  for (let i = 0; i < numHashes; i++) {
    // Create different hash variants by adding salt
    const saltedText = `${normalizedText}_salt_${i}`;
    const hash = crypto.createHash('sha256').update(saltedText).digest();
    
    // Convert bytes to normalized floats between -1 and 1
    for (let j = 0; j < 8 && embedding.length < dimension; j++) {
      const byteValue = hash[j];
      // Convert byte (0-255) to float (-1 to 1)
      const normalizedValue = (byteValue / 127.5) - 1;
      embedding.push(normalizedValue);
    }
  }
  
  // Ensure exact dimension
  return embedding.slice(0, dimension);
}

/**
 * Calculate cosine similarity between two vectors
 * Returns a value between -1 and 1, where 1 means identical
 */
export function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length) {
    throw new Error(`Vector dimensions don't match: ${vectorA.length} vs ${vectorB.length}`);
  }
  
  if (vectorA.length === 0) {
    return 0;
  }
  
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  
  for (let i = 0; i < vectorA.length; i++) {
    dotProduct += vectorA[i] * vectorB[i];
    magnitudeA += vectorA[i] * vectorA[i];
    magnitudeB += vectorB[i] * vectorB[i];
  }
  
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  
  // Avoid division by zero
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }
  
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Calculate relevance score for a memory based on semantic similarity, recency, and confidence
 * Formula: 60% semantic similarity + 30% recency + 10% confidence
 */
export function calculateRelevanceScore(
  memory: Memory,
  queryEmbedding?: number[],
  currentChapter?: number
): number {
  let semanticScore = 0;
  let recencyScore = 0;
  const confidenceScore = memory.confidence;
  
  // Semantic similarity (60% weight)
  if (queryEmbedding && memory.embedding) {
    const similarity = cosineSimilarity(memory.embedding, queryEmbedding);
    // Normalize from [-1, 1] to [0, 1]
    semanticScore = (similarity + 1) / 2;
  }
  
  // Recency score (30% weight)
  if (currentChapter !== undefined) {
    const memoryChapter = memory.valid_from;
    const chapterDifference = currentChapter - memoryChapter;
    
    // More recent memories score higher
    // Use exponential decay: score = e^(-λ * distance)
    const decayRate = 0.1; // Adjust this to control how quickly scores decay
    recencyScore = Math.exp(-decayRate * Math.max(0, chapterDifference));
  } else {
    // If no current chapter provided, use a neutral recency score
    recencyScore = 0.5;
  }
  
  // Weighted combination
  const weightedScore = (
    semanticScore * 0.6 +
    recencyScore * 0.3 +
    confidenceScore * 0.1
  );
  
  return Math.max(0, Math.min(1, weightedScore)); // Clamp to [0, 1]
}

/**
 * Enhanced relevance scoring with additional factors
 */
export function calculateEnhancedRelevanceScore(
  memory: Memory,
  options: {
    queryEmbedding?: number[];
    currentChapter?: number;
    queryEntities?: string[]; // Entity names from the query
    preferredTypes?: string[]; // Preferred memory types
    weights?: {
      semantic?: number;
      recency?: number;
      confidence?: number;
      entityMatch?: number;
      typeMatch?: number;
    };
  } = {}
): number {
  const weights = {
    semantic: 0.4,
    recency: 0.25,
    confidence: 0.1,
    entityMatch: 0.15,
    typeMatch: 0.1,
    ...options.weights
  };
  
  let semanticScore = 0;
  let recencyScore = 0;
  let entityMatchScore = 0;
  let typeMatchScore = 0;
  const confidenceScore = memory.confidence;
  
  // Semantic similarity
  if (options.queryEmbedding && memory.embedding) {
    const similarity = cosineSimilarity(memory.embedding, options.queryEmbedding);
    semanticScore = (similarity + 1) / 2;
  }
  
  // Recency score
  if (options.currentChapter !== undefined) {
    const chapterDifference = options.currentChapter - memory.valid_from;
    const decayRate = 0.08;
    recencyScore = Math.exp(-decayRate * Math.max(0, chapterDifference));
  } else {
    recencyScore = 0.5;
  }
  
  // Entity matching score
  if (options.queryEntities && options.queryEntities.length > 0) {
    const memoryEntities = [...memory.subjects, ...(memory.objects || [])];
    const matches = options.queryEntities.filter(entity => 
      memoryEntities.some(memEntity => 
        memEntity.toLowerCase().includes(entity.toLowerCase()) ||
        entity.toLowerCase().includes(memEntity.toLowerCase())
      )
    );
    entityMatchScore = matches.length / options.queryEntities.length;
  }
  
  // Type matching score
  if (options.preferredTypes && options.preferredTypes.length > 0) {
    typeMatchScore = options.preferredTypes.includes(memory.type) ? 1 : 0;
  }
  
  // Weighted combination
  const weightedScore = (
    semanticScore * weights.semantic +
    recencyScore * weights.recency +
    confidenceScore * weights.confidence +
    entityMatchScore * weights.entityMatch +
    typeMatchScore * weights.typeMatch
  );
  
  return Math.max(0, Math.min(1, weightedScore));
}

/**
 * Find the most similar memories to a query using brute-force search
 */
export function findSimilarMemories(
  queryEmbedding: number[],
  memories: Memory[],
  options: {
    limit?: number;
    threshold?: number;
    currentChapter?: number;
  } = {}
): Array<{ memory: Memory; score: number; similarity: number }> {
  const { limit = 10, threshold = 0.0, currentChapter } = options;
  
  const scoredMemories = memories
    .map(memory => {
      if (!memory.embedding) {
        return null;
      }
      
      const similarity = cosineSimilarity(queryEmbedding, memory.embedding);
      const relevanceScore = calculateRelevanceScore(memory, queryEmbedding, currentChapter);
      
      return {
        memory,
        score: relevanceScore,
        similarity: (similarity + 1) / 2 // Normalize to [0, 1]
      };
    })
    .filter((item): item is NonNullable<typeof item> => 
      item !== null && item.score >= threshold
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  return scoredMemories;
}

/**
 * Generate embedding for memory content (canonical_fact + raw_content)
 */
export function generateMemoryEmbedding(memory: Pick<Memory, 'canonical_fact' | 'raw_content'>): number[] {
  const combinedText = `${memory.canonical_fact} ${memory.raw_content}`;
  return generateHashEmbedding(combinedText);
}

/**
 * Generate embedding for a search query
 */
export function generateQueryEmbedding(query: string): number[] {
  return generateHashEmbedding(query);
}

/**
 * Batch generate embeddings for multiple memories
 */
export function batchGenerateEmbeddings(
  memories: Array<Pick<Memory, 'canonical_fact' | 'raw_content'>>
): number[][] {
  return memories.map(memory => generateMemoryEmbedding(memory));
}

/**
 * Calculate similarity statistics for a set of memories
 */
export function calculateSimilarityStats(memories: Memory[]): {
  averageSimilarity: number;
  maxSimilarity: number;
  minSimilarity: number;
  similarityDistribution: { range: string; count: number }[];
} {
  if (memories.length < 2) {
    return {
      averageSimilarity: 0,
      maxSimilarity: 0,
      minSimilarity: 0,
      similarityDistribution: []
    };
  }
  
  const similarities: number[] = [];
  
  // Calculate pairwise similarities
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const memA = memories[i];
      const memB = memories[j];
      
      if (memA.embedding && memB.embedding) {
        const similarity = cosineSimilarity(memA.embedding, memB.embedding);
        similarities.push((similarity + 1) / 2); // Normalize to [0, 1]
      }
    }
  }
  
  if (similarities.length === 0) {
    return {
      averageSimilarity: 0,
      maxSimilarity: 0,
      minSimilarity: 0,
      similarityDistribution: []
    };
  }
  
  const averageSimilarity = similarities.reduce((sum, sim) => sum + sim, 0) / similarities.length;
  const maxSimilarity = Math.max(...similarities);
  const minSimilarity = Math.min(...similarities);
  
  // Create distribution buckets
  const buckets = [
    { range: '0.0-0.2', count: 0 },
    { range: '0.2-0.4', count: 0 },
    { range: '0.4-0.6', count: 0 },
    { range: '0.6-0.8', count: 0 },
    { range: '0.8-1.0', count: 0 }
  ];
  
  similarities.forEach(sim => {
    if (sim < 0.2) buckets[0].count++;
    else if (sim < 0.4) buckets[1].count++;
    else if (sim < 0.6) buckets[2].count++;
    else if (sim < 0.8) buckets[3].count++;
    else buckets[4].count++;
  });
  
  return {
    averageSimilarity,
    maxSimilarity,
    minSimilarity,
    similarityDistribution: buckets
  };
}

/**
 * Utility to normalize similarity scores to a 0-1 range
 */
export function normalizeSimilarity(similarity: number): number {
  return Math.max(0, Math.min(1, (similarity + 1) / 2));
}

/**
 * Calculate Euclidean distance between two vectors
 */
export function euclideanDistance(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length) {
    throw new Error(`Vector dimensions don't match: ${vectorA.length} vs ${vectorB.length}`);
  }
  
  let sumSquaredDifferences = 0;
  for (let i = 0; i < vectorA.length; i++) {
    const diff = vectorA[i] - vectorB[i];
    sumSquaredDifferences += diff * diff;
  }
  
  return Math.sqrt(sumSquaredDifferences);
}

/**
 * Calculate Manhattan distance between two vectors
 */
export function manhattanDistance(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length) {
    throw new Error(`Vector dimensions don't match: ${vectorA.length} vs ${vectorB.length}`);
  }
  
  let sumAbsoluteDifferences = 0;
  for (let i = 0; i < vectorA.length; i++) {
    sumAbsoluteDifferences += Math.abs(vectorA[i] - vectorB[i]);
  }
  
  return sumAbsoluteDifferences;
}