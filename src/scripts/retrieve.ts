#!/usr/bin/env node

import { MemoryService } from '../services/MemoryService';
import { initializeDatabase } from '../storage/database';
import { config, ensureDataDirectory } from '../utils/config';
import { RetrievalContext } from '../types';

async function retrieve() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Memory Retrieval CLI

Usage: npm run retrieve [query] [options]

Options:
  -c, --chapter <num>    Filter by chapter number
  -l, --limit <num>      Max results (default: 10)
  -t, --threshold <num>  Similarity threshold 0-1 (default: 0.3)
  -f, --character <name> Filter by character name
  -h, --help            Show this help

Examples:
  npm run retrieve "What is Byleth's relationship with Dimitri?"
  npm run retrieve "Show memories from chapter 5" --chapter 5
  npm run retrieve "Sylvain relationships" --character Sylvain --limit 5
    `);
    process.exit(0);
  }

  // Parse query and options
  let query = '';
  let chapter: number | undefined;
  let limit = 10;
  let threshold = 0.3;
  let character: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '-c' || arg === '--chapter') {
      chapter = parseInt(args[++i]);
    } else if (arg === '-l' || arg === '--limit') {
      limit = parseInt(args[++i]);
    } else if (arg === '-t' || arg === '--threshold') {
      threshold = parseFloat(args[++i]);
    } else if (arg === '-f' || arg === '--character') {
      character = args[++i];
    } else if (!arg.startsWith('-')) {
      query = arg;
    }
  }

  // Initialize
  ensureDataDirectory();
  await initializeDatabase(config.storage.databasePath);
  const memoryService = MemoryService.fromConfig();

  // Build retrieval context
  const context: RetrievalContext = {
    limit,
    threshold,
    filters: {}
  };

  if (query) {
    context.query = query;
  }

  if (chapter !== undefined) {
    context.filters!.chapterNumber = chapter;
  }

  if (character) {
    context.filters!.characterName = character;
  }

  // Perform retrieval
  console.log('🔍 Searching memories...\n');
  
  try {
    const result = await memoryService.retrieveMemories(context);
    
    if (result.memories.length === 0) {
      console.log('No memories found matching your criteria.');
      return;
    }

    console.log(`Found ${result.memories.length} memories:\n`);

    // Display results
    result.memories.forEach((memory, index) => {
      console.log(`${index + 1}. [Ch.${memory.valid_from}] ${memory.type} - ${memory.predicate}`);
      console.log(`   "${memory.canonical_fact}"`);
      
      if (memory.subjects?.length > 0) {
        console.log(`   Subjects: ${memory.subjects.join(', ')}`);
      }
      
      if (memory.objects?.length > 0) {
        console.log(`   Objects: ${memory.objects.join(', ')}`);
      }
      
      if (result.relevanceScores && result.relevanceScores[memory.id]) {
        console.log(`   Relevance: ${(result.relevanceScores[memory.id] * 100).toFixed(1)}%`);
      }
      
      console.log();
    });

    if (result.executionTime) {
      console.log(`⏱️  Search completed in ${result.executionTime}ms`);
    }

  } catch (error) {
    console.error('❌ Error retrieving memories:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  retrieve().catch(error => {
    console.error('❌ Retrieval failed:', error);
    process.exit(1);
  });
}