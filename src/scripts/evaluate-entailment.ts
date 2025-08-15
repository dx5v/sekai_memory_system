#!/usr/bin/env node

import * as fs from 'fs';
import { MemoryService } from '../services/MemoryService';
import { EvaluationPipeline } from '../services/LLMEvaluationPipeline';
import { TestCase, GoldFact } from '../services/LLMEvaluator';
import { initializeDatabase } from '../storage/database';
import { config, ensureDataDirectory } from '../utils/config';

async function runEntailmentEvaluation() {
  console.log('🔍 Starting entailment-based evaluation...');
  
  // Initialize
  ensureDataDirectory();
  await initializeDatabase(config.storage.databasePath);
  const memoryService = MemoryService.fromConfig();
  
  if (!config.llm.apiKey) {
    console.error('❌ OpenAI API key required for evaluation. Please set OPENAI_API_KEY in .env file.');
    process.exit(1);
  }
  
  // Load test cases and gold facts
  const testCasesPath = 'test_cases.jsonl';
  const goldFactsPath = 'gold_facts.jsonl';
  
  if (!fs.existsSync(testCasesPath)) {
    console.error(`❌ Test cases file not found: ${testCasesPath}`);
    console.log('💡 Run "npm run generate-test-cases" first to create test cases.');
    process.exit(1);
  }
  
  if (!fs.existsSync(goldFactsPath)) {
    console.error(`❌ Gold facts file not found: ${goldFactsPath}`);
    console.log('💡 Run "npm run generate-gold-facts" first to create gold facts.');
    process.exit(1);
  }
  
  const testCasesContent = fs.readFileSync(testCasesPath, 'utf-8');
  const testCases: TestCase[] = testCasesContent
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
    
  const goldFactsContent = fs.readFileSync(goldFactsPath, 'utf-8');
  const goldFacts: GoldFact[] = goldFactsContent
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  
  console.log(`📚 Loaded ${testCases.length} test cases and ${goldFacts.length} gold facts`);
  
  // Check database status
  const stats = await memoryService.getMemoryStatistics();
  console.log(`💾 Database: ${stats.totalMemories} total memories, ${stats.activeMemories} active`);
  
  if (stats.totalMemories === 0) {
    console.error('❌ Database is empty. Please run ingestion first.');
    console.log('💡 Run "npm run ingest-chapters" to populate the database.');
    process.exit(1);
  }
  
  // Create evaluation pipeline
  const evaluationPipeline = EvaluationPipeline.fromConfig(memoryService, {
    retrievalLimit: 20,
    retrievalThreshold: 0.3,
    verbose: true,
    maxConcurrentEvaluations: 2  // Conservative to avoid API rate limits
  });
  
  // Run evaluation on all test cases
  console.log(`🎯 Running evaluation on all ${testCases.length} test cases...`);
  
  // Run evaluation
  const result = await evaluationPipeline.evaluateTestCases(testCases, goldFacts);
  
  // Display results
  console.log('\n' + '='.repeat(60));
  console.log('📊 ENTAILMENT-BASED EVALUATION RESULTS');
  console.log('='.repeat(60));
  
  const metrics = result.overallMetrics;
  
  console.log(`\n📈 Overall Metrics:`);
  console.log(`   Test Cases: ${metrics.totalTestCases}`);
  console.log(`   Total Retrievals: ${metrics.totalRetrievals}`);
  console.log(`   Total Entailment Evaluations: ${metrics.totalEntailmentEvaluations}`);
  console.log(`   Execution Time: ${(result.executionTime / 1000).toFixed(1)}s`);
  
  console.log(`\n🎯 Entailment Metrics:`);
  console.log(`   Average True Positives per test: ${metrics.avgTruePositives.toFixed(2)}`);
  console.log(`   Average Contradictions per test: ${metrics.avgContradictions.toFixed(2)}`);
  console.log(`   Average Unrelated per test: ${metrics.avgUnrelated.toFixed(2)}`);
  
  console.log(`\n📊 Performance Metrics:`);
  console.log(`   Average Precision: ${(metrics.avgPrecision * 100).toFixed(1)}%`);
  console.log(`   True Positive Rate: ${(metrics.truePositiveRate * 100).toFixed(1)}%`);
  console.log(`   Average Stale@K: ${(metrics.avgStaleAtK * 100).toFixed(1)}%`);
  console.log(`   Contradiction Rate: ${(metrics.contradictionRate * 100).toFixed(1)}%`);
  
  // Show sample results
  console.log(`\n📋 Sample Test Case Results:`);
  const sampleResults = result.testCaseResults.slice(0, 3);
  
  for (let i = 0; i < sampleResults.length; i++) {
    const tcResult = sampleResults[i];
    console.log(`\n   ${i + 1}. Test Case: ${tcResult.testCase.id}`);
    console.log(`      Query: "${tcResult.testCase.query}"`);
    console.log(`      Chapter: ${tcResult.testCase.chapter}`);
    console.log(`      Expected Gold IDs: [${tcResult.testCase.expectedGoldIds.join(', ')}]`);
    console.log(`      Retrieved: ${tcResult.retrievedMemories.length} memories`);
    console.log(`      Entailment Results: ${tcResult.truePositives} entails, ${tcResult.contradictions} contradicts, ${tcResult.unrelated} unrelated`);
    console.log(`      Precision: ${(tcResult.precision * 100).toFixed(1)}%, Stale@K: ${(tcResult.staleAtK * 100).toFixed(1)}%`);
  }
  
  // Save detailed results
  const resultsPath = 'evaluation_results.json';
  fs.writeFileSync(resultsPath, JSON.stringify(result, null, 2));
  console.log(`\n💾 Detailed results saved to: ${resultsPath}`);
  
  // Generate summary report
  const summaryPath = 'evaluation_summary.md';
  const summary = generateSummaryReport(result, testCases.length, testCases.length);
  fs.writeFileSync(summaryPath, summary);
  console.log(`📄 Summary report saved to: ${summaryPath}`);
  
  console.log('\n✅ Entailment-based evaluation complete!');
}

function generateSummaryReport(result: any, testedCases: number, _totalCases: number): string {
  const metrics = result.overallMetrics;
  
  return `# Entailment-Based Evaluation Report

## Overview
- **Evaluation Method**: Entailment-based using LLM judge
- **Test Cases Evaluated**: ${testedCases}
- **Execution Time**: ${(result.executionTime / 1000).toFixed(1)} seconds
- **Total Retrievals**: ${metrics.totalRetrievals}
- **Total Entailment Evaluations**: ${metrics.totalEntailmentEvaluations}

## Key Metrics

### Entailment Distribution
- **True Positives (entails)**: ${metrics.avgTruePositives.toFixed(2)} per test case
- **Contradictions**: ${metrics.avgContradictions.toFixed(2)} per test case
- **Unrelated**: ${metrics.avgUnrelated.toFixed(2)} per test case

### Performance Metrics
- **Average Precision**: ${(metrics.avgPrecision * 100).toFixed(1)}%
- **True Positive Rate**: ${(metrics.truePositiveRate * 100).toFixed(1)}%
- **Stale@K (contradiction rate)**: ${(metrics.avgStaleAtK * 100).toFixed(1)}%
- **Overall Contradiction Rate**: ${(metrics.contradictionRate * 100).toFixed(1)}%

## Evaluation Approach

This evaluation uses entailment-based scoring where:

1. **Query Execution**: Each test case query is executed against the memory retrieval system
2. **Entailment Evaluation**: For each retrieved memory and expected gold fact, an LLM judge determines:
   - **entails**: Retrieved fact fully answers the question implied by the gold fact (counted as True Positive)
   - **contradicts**: Retrieved fact conflicts with the gold fact, often indicating stale information (counted toward Stale@K)
   - **unrelated**: Retrieved fact doesn't address the same question (ignored)

3. **Metrics Calculation**:
   - **Precision**: True Positives / Total Evaluations
   - **True Positive Rate**: Total TPs / Total Expected Gold Facts
   - **Stale@K**: Contradictions / Total Expected Gold Facts

## Generated on: ${new Date().toISOString()}
`;
}

if (require.main === module) {
  runEntailmentEvaluation().catch(error => {
    console.error('❌ Evaluation failed:', error);
    process.exit(1);
  });
}