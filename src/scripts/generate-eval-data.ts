#!/usr/bin/env tsx
/**
 * Generate Evaluation Data Script
 * 
 * Processes memory_data.json to generate:
 * 1. gold_facts.jsonl - Expected facts/memories from each chapter
 * 2. eval_queries.jsonl - Test queries with expected fact IDs
 */

import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { config } from '../utils/config';

interface ChapterData {
  chapter_number: number;
  synopsis: string;
}

interface GoldFact {
  id: string;
  type: 'IC' | 'C2U' | 'WM';
  predicate: string;
  subjects: string[];
  objects?: string[];
  valid_from: number;
  valid_to: number | null;
  canonical_fact: string;
}

interface EvalQuery {
  qid: string;
  chapter: number;
  focus: string[];
  query: string;
  expected: string[];
}

class EvaluationDataGenerator {
  private openai: OpenAI;
  private factCounter: number = 0;
  private queryCounter: number = 0;
  private allFacts: GoldFact[] = [];
  private allQueries: EvalQuery[] = [];

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Generate gold facts from a chapter
   */
  private async generateFactsForChapter(chapter: ChapterData): Promise<GoldFact[]> {
    const prompt = `Extract key facts from this chapter that should be stored as memories. Focus on relationships, character knowledge, and world state changes.

Chapter ${chapter.chapter_number}: ${chapter.synopsis}

Generate 3-6 important facts in JSON format:
{
  "facts": [
    {
      "type": "IC|C2U|WM",
      "predicate": "relationship_verb",
      "subjects": ["character_name"],
      "objects": ["character_name"], // only for IC type
      "canonical_fact": "clear fact statement"
    }
  ]
}

Types:
- IC: Inter-character relationships (requires objects)
- C2U: Character to user/player knowledge
- WM: World state/events

Examples of predicates: trusts, loves, fears, knows, is_in_relationship_with, works_with, protects, threatens, etc.`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at extracting structured facts from narrative text.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content;
      if (!response) throw new Error('No response from LLM');

      const parsed = JSON.parse(response);
      const facts: GoldFact[] = [];

      for (const fact of parsed.facts || []) {
        this.factCounter++;
        const goldFact: GoldFact = {
          id: `F${String(this.factCounter).padStart(3, '0')}`,
          type: fact.type,
          predicate: fact.predicate,
          subjects: fact.subjects,
          objects: fact.objects,
          valid_from: chapter.chapter_number,
          valid_to: null,
          canonical_fact: fact.canonical_fact
        };
        facts.push(goldFact);
      }

      return facts;
    } catch (error) {
      console.error(`Error generating facts for chapter ${chapter.chapter_number}:`, error);
      return [];
    }
  }

  /**
   * Generate evaluation queries for a chapter
   */
  private async generateQueriesForChapter(
    chapter: ChapterData, 
    relevantFacts: GoldFact[]
  ): Promise<EvalQuery[]> {
    const factSummary = relevantFacts.map(f => 
      `${f.id}: ${f.canonical_fact}`
    ).join('\n');

    const prompt = `Based on this chapter and its facts, generate 2-4 natural questions that someone might ask about the story.

Chapter ${chapter.chapter_number}: ${chapter.synopsis}

Known facts from this chapter:
${factSummary}

Generate queries in JSON format:
{
  "queries": [
    {
      "focus": ["main_character_involved"],
      "query": "natural question about the chapter",
      "expected_facts": ["fact_id_that_answers_this"]
    }
  ]
}

Make queries natural, like:
- "What is the relationship between X and Y?"
- "How does X feel about Y?"
- "What happened to X?"
- "Who does X trust?"
- "What is X's current situation?"`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are creating test queries for a memory retrieval system.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.4,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content;
      if (!response) throw new Error('No response from LLM');

      const parsed = JSON.parse(response);
      const queries: EvalQuery[] = [];

      for (const query of parsed.queries || []) {
        this.queryCounter++;
        const evalQuery: EvalQuery = {
          qid: `Q${String(this.queryCounter).padStart(3, '0')}`,
          chapter: chapter.chapter_number,
          focus: query.focus || [],
          query: query.query,
          expected: query.expected_facts || []
        };
        queries.push(evalQuery);
      }

      return queries;
    } catch (error) {
      console.error(`Error generating queries for chapter ${chapter.chapter_number}:`, error);
      return [];
    }
  }

  /**
   * Process all chapters to generate evaluation data
   */
  public async generateEvaluationData(memoryDataPath: string) {
    console.log('🚀 Starting evaluation data generation...\n');

    // Load memory data
    const memoryData = JSON.parse(
      fs.readFileSync(memoryDataPath, 'utf-8')
    ) as ChapterData[];

    console.log(`📚 Processing ${memoryData.length} chapters...\n`);

    // Process each chapter
    for (const chapter of memoryData) {
      console.log(`📖 Processing Chapter ${chapter.chapter_number}...`);
      
      // Generate facts
      const facts = await this.generateFactsForChapter(chapter);
      this.allFacts.push(...facts);
      console.log(`   ✅ Generated ${facts.length} facts`);

      // Generate queries based on facts
      const queries = await this.generateQueriesForChapter(chapter, facts);
      this.allQueries.push(...queries);
      console.log(`   ✅ Generated ${queries.length} queries`);

      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Write gold facts to JSONL
    const factsPath = path.join(process.cwd(), 'gold_facts.jsonl');
    const factsContent = this.allFacts
      .map(fact => JSON.stringify(fact))
      .join('\n');
    fs.writeFileSync(factsPath, factsContent);
    console.log(`\n✅ Wrote ${this.allFacts.length} facts to gold_facts.jsonl`);

    // Write eval queries to JSONL
    const queriesPath = path.join(process.cwd(), 'eval_queries.jsonl');
    const queriesContent = this.allQueries
      .map(query => JSON.stringify(query))
      .join('\n');
    fs.writeFileSync(queriesPath, queriesContent);
    console.log(`✅ Wrote ${this.allQueries.length} queries to eval_queries.jsonl`);

    // Summary statistics
    console.log('\n📊 Generation Summary:');
    console.log(`   Total Facts: ${this.allFacts.length}`);
    console.log(`   - IC: ${this.allFacts.filter(f => f.type === 'IC').length}`);
    console.log(`   - C2U: ${this.allFacts.filter(f => f.type === 'C2U').length}`);
    console.log(`   - WM: ${this.allFacts.filter(f => f.type === 'WM').length}`);
    console.log(`   Total Queries: ${this.allQueries.length}`);
    console.log(`   Average facts per chapter: ${(this.allFacts.length / memoryData.length).toFixed(1)}`);
    console.log(`   Average queries per chapter: ${(this.allQueries.length / memoryData.length).toFixed(1)}`);
  }
}

// CLI execution
async function main() {
  const args = process.argv.slice(2);
  
  // Parse arguments
  let memoryDataPath = 'memory_data.json';
  let apiKey = config.llm.apiKey;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--memory-data' && args[i + 1]) {
      memoryDataPath = args[i + 1];
      i++;
    } else if (args[i] === '--api-key' && args[i + 1]) {
      apiKey = args[i + 1];
      i++;
    } else if (args[i] === '--help') {
      console.log(`
Generate Evaluation Data for Sekai Memory System

Usage: tsx generate-eval-data.ts [options]

Options:
  --memory-data <path>  Path to memory_data.json (default: memory_data.json)
  --api-key <key>       OpenAI API key (default: from config)
  --help               Show this help message

Output:
  gold_facts.jsonl    - Expected facts from each chapter
  eval_queries.jsonl  - Test queries with expected fact IDs

Example:
  tsx generate-eval-data.ts --memory-data data/memory_data.json
      `);
      process.exit(0);
    }
  }

  // Validate inputs
  if (!fs.existsSync(memoryDataPath)) {
    console.error(`❌ Memory data file not found: ${memoryDataPath}`);
    process.exit(1);
  }

  if (!apiKey) {
    console.error('❌ OpenAI API key not configured. Set OPENAI_API_KEY or use --api-key');
    process.exit(1);
  }

  // Generate evaluation data
  try {
    const generator = new EvaluationDataGenerator(apiKey);
    await generator.generateEvaluationData(memoryDataPath);
    console.log('\n✨ Evaluation data generation completed!');
  } catch (error) {
    console.error('❌ Generation failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { EvaluationDataGenerator };