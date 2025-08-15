#!/usr/bin/env node

import * as fs from 'fs';
import OpenAI from 'openai';
import { MemoryService } from '../services/MemoryService';
import { initializeDatabase } from '../storage/database';
import { config, ensureDataDirectory } from '../utils/config';

interface TestCase {
  qid: string;
  chapter: number;
  focus?: string[];
  query: string;
  expected: string[];
}

interface GoldFact {
  id: string;
  type: string;
  predicate: string;
  subjects: string[];
  objects?: string[];
  valid_from: number;
  valid_to: number | null;
  canonical_fact: string;
}

type LLMJudgeResponse = 'entails' | 'contradicts' | 'unrelated';

// LLM Judge function
async function evaluateWithLLMJudge(
  openai: OpenAI,
  query: string, 
  chapter: number, 
  retrievedFact: string, 
  goldFact: string
): Promise<LLMJudgeResponse> {
  const prompt = `Given Query "${query}" at chapter ${chapter}, does RETRIEVED_FACT fully answer the question implied by GOLD_FACT?

RETRIEVED_FACT: "${retrievedFact}"
GOLD_FACT: "${goldFact}"

Answer with exactly one word: entails, contradicts, or unrelated`;

  try {
    const response = await openai.chat.completions.create({
      model: config.llm.model,
      max_completion_tokens: 10,
      messages: [{ role: 'user', content: prompt }]
    });

    const answer = response.choices[0]?.message?.content?.trim().toLowerCase() || 'unrelated';
    
    if (answer.includes('entails')) return 'entails';
    if (answer.includes('contradicts')) return 'contradicts';
    return 'unrelated';
    
  } catch (error) {
    console.warn(`⚠️  LLM evaluation failed: ${error}`);
    return 'unrelated';
  }
}

async function runEvaluation() {
  console.log('🚀 Starting simple evaluation...');
  
  // Initialize
  ensureDataDirectory();
  await initializeDatabase(config.storage.databasePath);
  const memoryService = MemoryService.fromConfig();
  
  // Initialize OpenAI for LLM judge (required by default)
  if (!config.llm.apiKey) {
    console.error('❌ OpenAI API key required for evaluation. Please set OPENAI_API_KEY in .env file.');
    process.exit(1);
  }
  
  const openai = new OpenAI({ apiKey: config.llm.apiKey });
  console.log('🤖 LLM Judge evaluation (default)');
  
  // Load test data
  const evalQueries: TestCase[] = fs.readFileSync('eval_queries.jsonl', 'utf-8')
    .trim().split('\n').map(line => JSON.parse(line));
  
  const goldFacts: GoldFact[] = fs.readFileSync('gold_facts.jsonl', 'utf-8')
    .trim().split('\n').map(line => JSON.parse(line));
  
  console.log(`📚 Loaded ${evalQueries.length} test queries and ${goldFacts.length} gold facts`);
  
  // Check database status
  const stats = await memoryService.getMemoryStatistics();
  console.log(`💾 Database: ${stats.totalMemories} total memories, ${stats.activeMemories} active`);
  
  if (stats.totalMemories === 0) {
    console.log('⚠️  Database is empty. Please run ingestion first.');
    return;
  }
  
  // Note: Database uses UUID IDs, but gold facts use F001-style IDs
  // Using LLM judge for semantic evaluation instead of exact ID matching
  console.log(`📋 Using LLM semantic evaluation...`);
  
  // Run evaluation
  let totalPrecision = 0;
  let totalRecall = 0;
  let totalQueries = 0;
  
  // LLM Judge tracking
  let entailsCount = 0;
  let contradictsCount = 0;
  let unrelatedCount = 0;
  let totalEvaluations = 0;
  
  // Limit to first 5 queries for demo to avoid high API costs
  const testQueries = evalQueries.slice(0, 5);
  
  for (const testCase of testQueries) {
    try {
      // Try retrieval without semantic query first, just by chapter
      const results = await memoryService.retrieveMemories({
        filters: { validAt: testCase.chapter },
        limit: 12
      });
      
      // Get expected gold facts for this test case
      const expectedFacts = goldFacts.filter(f => testCase.expected.includes(f.id));
      
      // LLM Judge evaluation for all retrieved vs expected facts
      let llmMatches = 0;
      
      for (const retrievedMemory of results.memories) {
        for (const expectedFact of expectedFacts) {
          const judgment = await evaluateWithLLMJudge(
            openai,
            testCase.query,
            testCase.chapter,
            retrievedMemory.canonical_fact,
            expectedFact.canonical_fact
          );
          
          totalEvaluations++;
          
          if (judgment === 'entails') {
            entailsCount++;
            llmMatches++;
          } else if (judgment === 'contradicts') {
            contradictsCount++;
          } else {
            unrelatedCount++;
          }
        }
      }
      
      // Calculate metrics based on LLM judgments
      const precision = results.memories.length > 0 ? llmMatches / Math.min(results.memories.length, 12) : 0;
      const recall = expectedFacts.length > 0 ? llmMatches / expectedFacts.length : 0;
      
      totalPrecision += precision;
      totalRecall += recall;
      totalQueries++;
      
      if (totalQueries <= 2) {
        console.log(`  Query ${testCase.qid}: "${testCase.query}"`);
        console.log(`    Expected: ${expectedFacts[0]?.canonical_fact.slice(0,50)}...`);
        console.log(`    Retrieved: ${results.memories[0]?.canonical_fact.slice(0,50)}...`);
        console.log(`    LLM matches: ${llmMatches}/${results.memories.length * expectedFacts.length} entails, P=${precision.toFixed(3)}, R=${recall.toFixed(3)}`);
      }
      
    } catch (error) {
      console.warn(`⚠️  Error processing query ${testCase.qid}: ${error}`);
    }
  }
  
  // Results
  const avgPrecision = totalPrecision / totalQueries;
  const avgRecall = totalRecall / totalQueries;
  
  console.log('\n=== Evaluation Results ===');
  console.log(`Precision@12: ${avgPrecision.toFixed(3)} (LLM semantic evaluation)`);
  console.log(`Recall@12: ${avgRecall.toFixed(3)} (LLM semantic evaluation)`);
  console.log(`Total queries: ${totalQueries}`);
  
  // Detailed LLM Judge breakdown
  console.log('\n=== LLM Judge Breakdown ===');
  console.log(`Entails: ${entailsCount}/${totalEvaluations} (${(entailsCount/totalEvaluations*100).toFixed(1)}%)`);
  console.log(`Contradicts: ${contradictsCount}/${totalEvaluations} (${(contradictsCount/totalEvaluations*100).toFixed(1)}%)`);
  console.log(`Unrelated: ${unrelatedCount}/${totalEvaluations} (${(unrelatedCount/totalEvaluations*100).toFixed(1)}%)`);
  console.log(`Total evaluations: ${totalEvaluations}`);
  
  console.log('✅ Evaluation complete!');
}

if (require.main === module) {
  runEvaluation().catch(error => {
    console.error('❌ Evaluation failed:', error);
    process.exit(1);
  });
}