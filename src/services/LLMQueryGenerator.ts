import OpenAI from 'openai';
import { config } from '../utils/config';

export interface TestCase {
  id: string;                          // tie back to gold id(s)
  chapter: number;
  focusCharacter?: string | undefined; // for filters
  partner?: string | undefined;
  query: string;
  expectedGoldIds: string[];           // subset of GoldMemory ids valid at 'chapter'
  negativeGoldIds?: string[] | undefined; // known-wrong cluster to test cross-talk
}

export interface GoldFact {
  id: string;
  type: string;
  predicate: string;
  subjects: string[];
  objects?: string[];
  valid_from: number;
  valid_to: number | null;
  canonical_fact: string;
}

export interface QueryVariants {
  direct: string;
  focused_character: string;
  paraphrase: string;
}

/**
 * Service for generating test queries from gold facts using LLM
 */
export class LLMQueryGenerator {
  private openai: OpenAI;
  private maxRetries: number;
  private baseDelay: number;
  private model: string;

  constructor(apiKey: string, maxRetries: number = 3, baseDelay: number = 1000, model: string = 'gpt-4o') {
    this.openai = new OpenAI({ apiKey });
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
    this.model = model;
  }

  /**
   * Generate query variants for a gold fact
   */
  public async generateQueryVariants(goldFact: GoldFact): Promise<QueryVariants> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const prompt = this.buildQueryPrompt(goldFact);
        
        const completion = await this.openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: prompt }
          ],
          temperature: 0,
          max_completion_tokens: 500,
          response_format: { type: 'json_object' }
        });
        
        const response = completion.choices[0]?.message?.content;
        if (!response) {
          throw new Error('No response from LLM');
        }

        return this.parseQueryVariants(response);

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt - 1);
          console.warn(`Query generation attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`Query generation failed after ${this.maxRetries} attempts. Last error: ${lastError?.message}`);
  }

  /**
   * Generate test cases for a list of gold facts
   */
  public async generateTestCases(goldFacts: GoldFact[]): Promise<TestCase[]> {
    const testCases: TestCase[] = [];
    
    console.log(`🔍 Generating test cases for ${goldFacts.length} gold facts...`);
    
    // Process each gold fact individually
    for (let i = 0; i < goldFacts.length; i++) {
      const fact = goldFacts[i];
      console.log(`📝 Processing fact ${i + 1}/${goldFacts.length}: ${fact.id} - ${fact.canonical_fact.slice(0, 50)}...`);
      
      try {
        // Generate query variants for this fact
        const variants = await this.generateQueryVariants(fact);
        
        // Create test cases for each variant
        const baseTestCase = {
          chapter: fact.valid_from,
          expectedGoldIds: [fact.id],
          focusCharacter: this.extractFocusCharacter(fact),
          partner: this.extractPartner(fact),
        };

        // Direct query
        testCases.push({
          ...baseTestCase,
          id: `${fact.id}_direct`,
          query: variants.direct,
        });

        // Focused character query
        testCases.push({
          ...baseTestCase,
          id: `${fact.id}_focused`,
          query: variants.focused_character,
        });

        // Paraphrase query
        testCases.push({
          ...baseTestCase,
          id: `${fact.id}_paraphrase`,
          query: variants.paraphrase,
        });

        // Add negative test case for cross-talk
        if (fact.type === 'IC' && fact.objects && fact.objects.length > 0) {
          const negativeIds = this.findNegativeGoldIds(fact, goldFacts, fact.valid_from);
          if (negativeIds.length > 0) {
            testCases.push({
              ...baseTestCase,
              id: `${fact.id}_negative`,
              query: this.generateNegativeQuery(fact, goldFacts),
              expectedGoldIds: [],
              negativeGoldIds: negativeIds,
            });
          }
        }

      } catch (error) {
        console.warn(`⚠️  Failed to generate queries for ${fact.id}: ${error}`);
      }
    }

    console.log(`✅ Generated ${testCases.length} test cases`);
    return testCases;
  }

  /**
   * Build the prompt for generating query variants
   */
  private buildQueryPrompt(goldFact: GoldFact): string {
    const subjects = goldFact.subjects.join(', ');
    const objects = goldFact.objects ? goldFact.objects.join(', ') : '';

    return `Generate 3 query variants for this memory fact:

FACT: ${goldFact.canonical_fact}
TYPE: ${goldFact.type}
SUBJECTS: ${subjects}
OBJECTS: ${objects}
CHAPTER: ${goldFact.valid_from}

Generate these 3 query types:

1. DIRECT: A straightforward question directly asking about the relationship/fact
2. FOCUSED_CHARACTER: A query focusing on one character's perspective/relationships 
3. PARAPHRASE: A more natural, conversational way to ask about the same information

Examples for "Alice trusts Bob with her secrets" at chapter 5:

DIRECT: "What is the relationship between Alice and Bob at chapter 5?"
FOCUSED_CHARACTER: "Show Alice's relationships by chapter 5."  
PARAPHRASE: "Who does Alice confide in around ch.5?"

Return only valid JSON with this structure:
{
  "direct": "question text here",
  "focused_character": "question text here", 
  "paraphrase": "question text here"
}

Make questions specific to the actual characters and chapter number provided.`;
  }

  /**
   * Get the system prompt for query generation
   */
  private getSystemPrompt(): string {
    return `You are a test query generator for a memory retrieval system. Your job is to create diverse, natural-sounding queries that test different ways users might ask about stored memories.

Generate queries that:
1. Are natural and conversational 
2. Include specific chapter references when relevant
3. Test different query styles (direct, character-focused, paraphrased)
4. Use the actual character names from the memory fact
5. Are specific enough to retrieve the target memory

Always return valid JSON with exactly the requested fields.`;
  }

  /**
   * Parse the LLM response into query variants
   */
  private parseQueryVariants(response: string): QueryVariants {
    try {
      const parsed = JSON.parse(response);
      
      if (!parsed.direct || !parsed.focused_character || !parsed.paraphrase) {
        throw new Error('Missing required query variant fields');
      }

      return {
        direct: parsed.direct.trim(),
        focused_character: parsed.focused_character.trim(),
        paraphrase: parsed.paraphrase.trim()
      };
    } catch (error) {
      throw new Error(`Failed to parse query variants: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract the focus character from a gold fact
   */
  private extractFocusCharacter(fact: GoldFact): string | undefined {
    if (fact.subjects && fact.subjects.length > 0) {
      return fact.subjects[0];
    }
    return undefined;
  }

  /**
   * Extract the partner/object character from a gold fact
   */
  private extractPartner(fact: GoldFact): string | undefined {
    if (fact.type === 'IC' && fact.objects && fact.objects.length > 0) {
      return fact.objects[0];
    }
    return undefined;
  }

  /**
   * Find negative gold IDs for cross-talk testing
   */
  private findNegativeGoldIds(targetFact: GoldFact, allFacts: GoldFact[], chapter: number): string[] {
    const negativeIds: string[] = [];
    
    // Find facts at the same chapter with different character combinations
    for (const fact of allFacts) {
      if (fact.id === targetFact.id || fact.valid_from !== chapter) {
        continue;
      }
      
      // For IC facts, look for different character relationships
      if (fact.type === 'IC' && targetFact.type === 'IC') {
        const hasOverlap = fact.subjects.some(s => targetFact.subjects.includes(s)) ||
                          (fact.objects && targetFact.objects && 
                           fact.objects.some(o => targetFact.objects!.includes(o)));
        
        // Include facts with different characters (no overlap)
        if (!hasOverlap) {
          negativeIds.push(fact.id);
        }
      }
    }
    
    return negativeIds.slice(0, 3); // Limit to 3 negative examples
  }

  /**
   * Generate a negative query that should NOT match the target fact
   */
  private generateNegativeQuery(targetFact: GoldFact, allFacts: GoldFact[]): string {
    // Find a different character relationship for cross-talk testing
    const otherCharacters = new Set<string>();
    
    for (const fact of allFacts) {
      if (fact.type === 'IC' && fact.id !== targetFact.id) {
        fact.subjects.forEach(s => otherCharacters.add(s));
        if (fact.objects) {
          fact.objects.forEach(o => otherCharacters.add(o));
        }
      }
    }
    
    // Remove target characters to get different ones
    targetFact.subjects.forEach(s => otherCharacters.delete(s));
    if (targetFact.objects) {
      targetFact.objects.forEach(o => otherCharacters.delete(o));
    }
    
    const otherChar = Array.from(otherCharacters)[0];
    const chapter = targetFact.valid_from;
    
    if (otherChar) {
      return `Show ${otherChar}'s relationships at chapter ${chapter}.`;
    }
    
    return `Show Felix's relationships at chapter ${chapter}.`;
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Legacy method for compatibility - TODO: Update LLMEvaluationPipeline
   */
  public async generateQueries(_chapter: any, _numQueries: number = 6): Promise<any[]> {
    console.warn('generateQueries method is deprecated. Use generateTestCases instead.');
    return [];
  }

  /**
   * Create an LLMQueryGenerator instance using the application configuration
   */
  public static fromConfig(): LLMQueryGenerator {
    return new LLMQueryGenerator(
      config.llm.apiKey,
      3,
      1000,
      config.llm.model
    );
  }
}