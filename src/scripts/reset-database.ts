#!/usr/bin/env node

/**
 * Database management script for Sekai Memory System
 * 
 * This script provides functionality to:
 * - Reset the database (clear all memories and entities)
 * - Reprocess chapter data from memory_data.json
 * - Optionally run evaluation after reset
 */

import * as fs from 'fs';
import * as path from 'path';
import { MemoryService } from '../services/MemoryService';
import { MemoryStore } from '../storage/MemoryStore';
import { initializeDatabase, getDatabaseManager } from '../storage/database';
import { config, ensureDataDirectory } from '../utils/config';

interface ResetConfig {
  memoryDataPath: string;
  runEvaluation: boolean;
  verbose: boolean;
}

/**
 * Database reset and reprocessing utility
 */
class DatabaseResetManager {
  private config: ResetConfig;

  constructor(config: ResetConfig) {
    this.config = config;
  }

  /**
   * Main reset operation
   */
  public async resetAndReprocess(): Promise<void> {
    console.log('🗑️  Sekai Memory System - Database Reset');
    console.log('=====================================');
    
    try {
      // Ensure data directory exists
      ensureDataDirectory();
      
      // Initialize database first
      await initializeDatabase(config.storage.databasePath);
      console.log('✓ Database connection established');
      
      // Reset the database
      console.log('🗑️  Clearing all memories and entities...');
      const dbManager = getDatabaseManager();
      await dbManager.resetDatabase();
      console.log('✓ Database reset completed');
      
      // Create fresh services
      const memoryStore = new MemoryStore();
      const { LLMExtractor } = require('../services/LLMExtractor');
      const memoryService = new MemoryService(LLMExtractor.fromConfig(), memoryStore);
      console.log('✓ Memory services initialized');
      
      // Reprocess data
      await this.ingestMemoryData(memoryService);
      
      // Get final statistics
      const stats = await memoryService.getMemoryStatistics();
      console.log('\\n📊 Final Database Statistics:');
      console.log(`   Total Memories: ${stats.totalMemories}`);
      console.log(`   Total Entities: ${stats.entityCount}`);
      
      if (this.config.runEvaluation) {
        console.log('\\n🚀 Running evaluation...');
        const { MemorySystemEvaluator } = require('./evaluate');
        
        const evaluator = new MemorySystemEvaluator({
          memoryDataPath: this.config.memoryDataPath,
          outputPath: path.join(process.cwd(), 'evaluation_report.json'),
          runConsistencyTests: true,
          runCoverageTests: true,
          runPerformanceTests: true,
          runLLMTests: false,
          llmQueriesPerChapter: 6,
          llmRetrievalLimit: 20,
          llmRetrievalThreshold: 0.3,
          verbose: this.config.verbose,
          resetDatabase: false // Already reset
        });
        
        await evaluator.initialize();
        await evaluator.runEvaluation();
      }
      
      console.log('\\n🎉 Database reset and reprocessing completed successfully!');
      
    } catch (error) {
      console.error('❌ Reset operation failed:', error);
      throw error;
    }
  }

  /**
   * Ingest memory data from file
   */
  private async ingestMemoryData(memoryService: MemoryService): Promise<void> {
    if (!fs.existsSync(this.config.memoryDataPath)) {
      throw new Error(`Memory data file not found: ${this.config.memoryDataPath}`);
    }

    console.log(`📚 Processing chapter data from ${this.config.memoryDataPath}...`);
    const memoryData = JSON.parse(fs.readFileSync(this.config.memoryDataPath, 'utf-8'));
    
    if (!Array.isArray(memoryData)) {
      throw new Error('Memory data file should contain an array of chapters');
    }
    
    console.log(`   Found ${memoryData.length} chapters to process`);
    
    // Use verbose mode and generate report
    const result = await memoryService.ingestChapters(memoryData, this.config.verbose, true);
    
    console.log(`✓ Processing completed:`);
    console.log(`   Chapters processed: ${result.chaptersProcessed}`);
    console.log(`   Memories created: ${result.memoriesCreated}`);
    console.log(`   Memories duplicated: ${result.memoriesDuplicated}`);
    console.log(`   Memories superseded: ${result.memoriesSuperseded}`);
    
    if (result.errors.length > 0) {
      console.warn(`⚠️  ${result.errors.length} errors encountered during processing`);
      if (this.config.verbose) {
        result.errors.forEach((error, index) => {
          console.warn(`   Error ${index + 1}: ${error}`);
        });
      }
    }
  }
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  
  // Help text
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Sekai Memory System - Database Reset Tool

Usage: npm run reset-database [options]

Options:
  --memory-data <path>    Path to memory_data.json file (default: ./memory_data.json)
  --with-evaluation       Run evaluation after reset and reprocessing
  --verbose, -v          Show detailed output
  --help, -h             Show this help message

Examples:
  npm run reset-database                          # Reset and reprocess with default settings
  npm run reset-database --with-evaluation       # Reset, reprocess, and run evaluation
  npm run reset-database --memory-data ./data/chapters.json --verbose
    `);
    process.exit(0);
  }
  
  const resetConfig: ResetConfig = {
    memoryDataPath: path.join(process.cwd(), 'memory_data.json'),
    runEvaluation: false,
    verbose: args.includes('--verbose') || args.includes('-v')
  };

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--memory-data':
        resetConfig.memoryDataPath = args[i + 1];
        i++;
        break;
      case '--with-evaluation':
        resetConfig.runEvaluation = true;
        break;
    }
  }

  try {
    const resetManager = new DatabaseResetManager(resetConfig);
    await resetManager.resetAndReprocess();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Database reset failed:', error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { DatabaseResetManager, ResetConfig };