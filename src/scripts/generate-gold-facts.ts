#!/usr/bin/env node

import * as fs from 'fs';
import { LLMExtractor } from '../services/LLMExtractor';
import { config, ensureDataDirectory } from '../utils/config';
import { ChapterData } from '../types';

interface GoldFact {
  id: string;
  type: string;
  predicate: string;
  subjects: string[];
  objects?: string[] | undefined;
  valid_from: number;
  valid_to: number | null;
  canonical_fact: string;
}

async function generateGoldFacts() {
  console.log('🔨 Generating gold facts using LLM extractor...');
  
  // Initialize
  ensureDataDirectory();
  
  if (!config.llm.apiKey) {
    console.error('❌ OpenAI API key required. Please set OPENAI_API_KEY in .env file.');
    process.exit(1);
  }
  
  // Load chapter data
  const memoryDataPath = 'memory_data.json';
  if (!fs.existsSync(memoryDataPath)) {
    console.error(`❌ Memory data file not found: ${memoryDataPath}`);
    process.exit(1);
  }
  
  const chapters: ChapterData[] = JSON.parse(fs.readFileSync(memoryDataPath, 'utf-8'));
  console.log(`📚 Loaded ${chapters.length} chapters`);
  
  // Initialize LLM extractor
  const llmExtractor = LLMExtractor.fromConfig();
  
  // Extract memories and convert to gold facts
  const goldFacts: GoldFact[] = [];
  let factCounter = 1;
  
  for (const chapter of chapters) {
    console.log(`\n📖 Processing chapter ${chapter.chapter_number}...`);
    
    try {
      const result = await llmExtractor.extractMemories({
        chapterNumber: chapter.chapter_number,
        synopsis: chapter.synopsis
      });
      
      console.log(`   Extracted ${result.memoriesExtracted.length} memories`);
      
      // Convert each extracted memory to gold fact format
      for (const memory of result.memoriesExtracted) {
        const goldFact: GoldFact = {
          id: `F${factCounter.toString().padStart(3, '0')}`, // F001, F002, etc.
          type: memory.type,
          predicate: memory.predicate,
          subjects: memory.subjects,
          objects: memory.objects,
          valid_from: memory.valid_from,
          valid_to: memory.valid_to || null,
          canonical_fact: memory.canonical_fact
        };
        
        goldFacts.push(goldFact);
        factCounter++;
      }
      
    } catch (error) {
      console.warn(`⚠️  Error processing chapter ${chapter.chapter_number}: ${error}`);
    }
  }
  
  // Write gold facts to JSONL format
  const goldFactsContent = goldFacts.map(fact => JSON.stringify(fact)).join('\n');
  const outputPath = 'gold_facts.jsonl';
  
  // Backup existing file if it exists
  if (fs.existsSync(outputPath)) {
    const backupPath = `${outputPath}.backup.${Date.now()}`;
    fs.copyFileSync(outputPath, backupPath);
    console.log(`💾 Backed up existing file to: ${backupPath}`);
  }
  
  fs.writeFileSync(outputPath, goldFactsContent);
  
  // Summary
  console.log(`\n✅ Generated ${goldFacts.length} gold facts`);
  console.log(`📄 Saved to: ${outputPath}`);
  
  // Show sample facts
  console.log('\n📋 Sample gold facts:');
  goldFacts.slice(0, 3).forEach(fact => {
    console.log(`   ${fact.id}: ${fact.canonical_fact.slice(0, 60)}...`);
  });
  
  // Type distribution
  const typeDistribution: Record<string, number> = {};
  goldFacts.forEach(fact => {
    typeDistribution[fact.type] = (typeDistribution[fact.type] || 0) + 1;
  });
  
  console.log('\n📊 Type distribution:');
  Object.entries(typeDistribution).forEach(([type, count]) => {
    console.log(`   ${type}: ${count} facts`);
  });
}

if (require.main === module) {
  generateGoldFacts().catch(error => {
    console.error('❌ Gold facts generation failed:', error);
    process.exit(1);
  });
}