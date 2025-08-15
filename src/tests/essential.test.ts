import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initializeServer } from '../api/server';
import { initializeDatabase } from '../storage/database';
import { MemoryStore } from '../storage/MemoryStore';
import { MemoryService } from '../services/MemoryService';
import { LLMExtractor } from '../services/LLMExtractor';

describe('Essential Tests', () => {
  let memoryStore: MemoryStore;
  let memoryService: MemoryService;

  beforeAll(async () => {
    await initializeDatabase(':memory:');
    await initializeServer();
    memoryStore = new MemoryStore();
    const llmExtractor = LLMExtractor.fromConfig();
    memoryService = new MemoryService(llmExtractor, memoryStore);
  });

  // Test 1: Health check
  test('API health check', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  // Test 2: Save a memory
  test('Save memory to database', async () => {
    const memory = {
      type: 'IC' as const,
      predicate: 'trusts',
      subjects: ['Alice'],
      objects: ['Bob'],
      canonical_fact: 'Alice trusts Bob',
      raw_content: 'Alice trusted Bob',
      confidence: 0.9,
      valid_from: 1
    };
    
    const id = await memoryStore.saveMemory(memory);
    expect(id).toBeTruthy();
  });

  // Test 3: Retrieve memories
  test('Retrieve memories from database', async () => {
    const memories = await memoryStore.getMemories();
    expect(Array.isArray(memories)).toBe(true);
  });

  // Test 4: Ingest chapter data
  test('Ingest chapter and extract memories', async () => {
    const chapters = [{
      chapter_number: 1,
      synopsis: "Alice meets Bob. They become friends."
    }];
    
    const result = await memoryService.ingestChapters(chapters);
    expect(result.chaptersProcessed).toBe(1);
    expect(result.memoriesCreated).toBeGreaterThanOrEqual(0);
  });

  // Test 5: API ingestion endpoint
  test('API ingestion endpoint', async () => {
    const testData = [{
      chapter_number: 2,
      synopsis: "Bob helps Alice with a problem."
    }];
    
    const testPath = path.join(process.cwd(), 'test_memory_data.json');
    fs.writeFileSync(testPath, JSON.stringify(testData));
    
    // Point to test file
    const originalPath = process.env.MEMORY_DATA_PATH;
    process.env.MEMORY_DATA_PATH = testPath;
    
    const response = await request(app).post('/ingest');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    
    // Cleanup
    fs.unlinkSync(testPath);
    process.env.MEMORY_DATA_PATH = originalPath;
  });

  // Test 6: API memory retrieval
  test('API memory retrieval', async () => {
    const response = await request(app).get('/memories?limit=5');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data.memories)).toBe(true);
  });

  // Test 7: Character search
  test('Search memories by character', async () => {
    const response = await request(app).get('/memories?character=Alice');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  // Test 8: Input validation
  test('Validate invalid input returns error', async () => {
    const response = await request(app).get('/memories?limit=-1');
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  // Test 9: Entity resolution
  test('Resolve entity names to IDs', async () => {
    const entityId = await memoryStore.resolveEntity('TestCharacter');
    expect(entityId).toBeTruthy();
    
    // Same name should return same ID
    const sameId = await memoryStore.resolveEntity('TestCharacter');
    expect(sameId).toBe(entityId);
  });

  // Test 10: Predicate validation accepts any string
  test('Predicate validation accepts custom predicates', async () => {
    const memory = {
      type: 'IC' as const,
      predicate: 'appreciates', // Custom predicate
      subjects: ['Alice'],
      objects: ['Bob'],
      canonical_fact: 'Alice appreciates Bob',
      raw_content: 'Alice appreciated Bob',
      confidence: 0.8,
      valid_from: 1
    };
    
    const id = await memoryStore.saveMemory(memory);
    expect(id).toBeTruthy();
  });
});