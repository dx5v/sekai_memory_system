#!/usr/bin/env node

import * as fs from 'fs';
import { LLMQueryGenerator, GoldFact } from '../services/LLMQueryGenerator';
import { config, ensureDataDirectory } from '../utils/config';

async function generateTestCases() {
  console.log('🔍 Generating test cases from gold facts...');
  
  // Initialize
  ensureDataDirectory();
  
  if (!config.llm.apiKey) {
    console.error('❌ OpenAI API key required. Please set OPENAI_API_KEY in .env file.');
    process.exit(1);
  }
  
  // Load gold facts
  const goldFactsPath = 'gold_facts.jsonl';
  if (!fs.existsSync(goldFactsPath)) {
    console.error(`❌ Gold facts file not found: ${goldFactsPath}`);
    console.log('💡 Run "npm run generate-gold-facts" first to create gold facts.');
    process.exit(1);
  }
  
  const goldFactsContent = fs.readFileSync(goldFactsPath, 'utf-8');
  const goldFacts: GoldFact[] = goldFactsContent
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  
  console.log(`📚 Loaded ${goldFacts.length} gold facts`);
  
  // Initialize LLM query generator
  const queryGenerator = LLMQueryGenerator.fromConfig();
  
  // Generate test cases for all gold facts
  console.log(`🎯 Processing all ${goldFacts.length} gold facts...`);
  
  const testCases = await queryGenerator.generateTestCases(goldFacts);
  
  // Write test cases to JSONL format
  const testCasesContent = testCases.map(testCase => JSON.stringify(testCase)).join('\n');
  const outputPath = 'test_cases.jsonl';
  
  // Backup existing file if it exists
  if (fs.existsSync(outputPath)) {
    const backupPath = `${outputPath}.backup.${Date.now()}`;
    fs.copyFileSync(outputPath, backupPath);
    console.log(`💾 Backed up existing file to: ${backupPath}`);
  }
  
  fs.writeFileSync(outputPath, testCasesContent);
  
  // Summary
  console.log(`\n✅ Generated ${testCases.length} test cases`);
  console.log(`📄 Saved to: ${outputPath}`);
  
  // Show sample test cases
  console.log('\n📋 Sample test cases:');
  testCases.slice(0, 5).forEach(testCase => {
    const type = testCase.id.includes('_direct') ? 'Direct' : 
                testCase.id.includes('_focused') ? 'Focused' : 
                testCase.id.includes('_paraphrase') ? 'Paraphrase' : 'Negative';
    console.log(`   ${testCase.id}: [${type}] "${testCase.query}"`);
  });
  
  // Test case breakdown
  const typeBreakdown = {
    direct: testCases.filter(tc => tc.id.includes('_direct')).length,
    focused: testCases.filter(tc => tc.id.includes('_focused')).length,
    paraphrase: testCases.filter(tc => tc.id.includes('_paraphrase')).length,
    negative: testCases.filter(tc => tc.id.includes('_negative')).length
  };
  
  console.log('\n📊 Test case breakdown:');
  Object.entries(typeBreakdown).forEach(([type, count]) => {
    console.log(`   ${type}: ${count} cases`);
  });
  
  // Character breakdown
  const characterCounts: Record<string, number> = {};
  testCases.forEach(tc => {
    if (tc.focusCharacter) {
      characterCounts[tc.focusCharacter] = (characterCounts[tc.focusCharacter] || 0) + 1;
    }
  });
  
  console.log('\n👥 Character focus breakdown:');
  Object.entries(characterCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .forEach(([character, count]) => {
      console.log(`   ${character}: ${count} cases`);
    });
}

if (require.main === module) {
  generateTestCases().catch(error => {
    console.error('❌ Test case generation failed:', error);
    process.exit(1);
  });
}