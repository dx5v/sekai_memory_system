import OpenAI from 'openai';
import {
  StructuredMemory,
  ValidPredicate,
  MemoryType,
  LLMExtractionRequest,
  ExtractionResult,
  LLMResponse,
  isValidMemoryType,
  isValidPredicate,
  MIN_CONFIDENCE_SCORE
} from '../types';
import { config } from '../utils/config';

export class LLMExtractor {
  private openai: OpenAI;
  private maxRetries: number;
  private baseDelay: number; // milliseconds
  private model: string;

  constructor(apiKey: string, maxRetries: number = 3, baseDelay: number = 1000, model: string = 'gpt-4o') {
    this.openai = new OpenAI({ apiKey });
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
    this.model = model;
  }

  /**
   * Extract structured memories from a chapter synopsis
   */
  public async extractMemories(request: LLMExtractionRequest): Promise<ExtractionResult> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const prompt = this.buildExtractionPrompt(request.chapterNumber, request.synopsis);
        
        const completion = await this.openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: prompt }
          ],
          temperature: 0,
          max_completion_tokens: 2000,
          response_format: { type: 'json_object' }
        });
        
        const response = completion.choices[0]?.message?.content;
        if (!response) {
          const finishReason = completion.choices[0]?.finish_reason;
          throw new Error(`No response from LLM. Finish reason: ${finishReason}. Model used ${completion.usage?.completion_tokens || 0} tokens.`);
        }

        // Parse and validate the response
        const memories = this.parseAndValidateResponse(response, request.chapterNumber);
        
        const result: ExtractionResult = {
          chapterNumber: request.chapterNumber,
          memoriesExtracted: memories,
          entitiesFound: this.extractUniqueEntities(memories),
          processingTime: Date.now() - startTime
        };

        if (completion.usage) {
          result.llmUsage = {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens
          };
        }

        return result;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.warn(`LLM extraction attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    throw new Error(`LLM extraction failed after ${this.maxRetries} attempts. Last error: ${lastError?.message}`);
  }

  /**
   * Build the extraction prompt for a specific chapter
   */
  public buildExtractionPrompt(chapterNumber: number, synopsis: string): string {
    return `Extract structured memories from this chapter synopsis. You must return ONLY valid JSON.

Chapter ${chapterNumber}: ${synopsis}

Extract memories as a JSON object with this EXACT structure:
{
  "memories": [
    {
      "type": "IC|C2U|WM",
      "predicate": "relationship_or_action_verb",
      "subjects": ["character_name"],
      "objects": ["character_name"], // REQUIRED for IC type, OMIT for C2U and WM
      "canonical_fact": "normalized_fact_statement",
      "raw_content": "original_text_from_synopsis",
      "confidence": 0.8
    }
  ]
}

CRITICAL EXAMPLES - FOLLOW THESE PATTERNS:

IC Memory (Inter-Character interaction):
{
  "type": "IC",
  "predicate": "trusts",
  "subjects": ["Alice"],
  "objects": ["Bob"],
  "canonical_fact": "Alice trusts Bob with her secrets",
  "raw_content": "Alice trusted Bob with her secret",
  "confidence": 0.9
}

C2U Memory (Character knowledge about User):
{
  "type": "C2U",
  "predicate": "trusts",
  "subjects": ["Alice"],
  "canonical_fact": "Alice trusts the User",
  "raw_content": "Alice showed trust toward the player",
  "confidence": 0.8
}

WM Memory (World/environmental state):
{
  "type": "WM",
  "predicate": "world_alert",
  "subjects": ["Kingdom"],
  "canonical_fact": "The kingdom is under attack",
  "raw_content": "Enemy forces approached the kingdom",
  "confidence": 0.9
}

ABSOLUTE REQUIREMENTS:
1. Memory types: ONLY "IC", "C2U", or "WM" (case-sensitive)
2. Predicate: Use clear, concise relationship/action verbs (e.g., trusts, fears, loves, knows, discovers, helps, etc.)
3. subjects: ALWAYS non-empty array with character names (NEVER empty [])
4. IC memories: MUST have both subjects AND objects arrays (both non-empty)
5. C2U/WM memories: subjects array required, NO objects field
6. Confidence: number between 0.5 and 1.0 only
7. canonical_fact: NEVER empty string
8. raw_content: NEVER empty string

COMMON VALIDATION ERRORS TO AVOID:
❌ Empty subjects: "subjects": []
❌ IC without objects: IC type missing "objects" field
❌ Empty strings: "canonical_fact": "", "raw_content": ""
❌ Empty or missing predicate

CHARACTER NAME RULES: Use actual names from text, not pronouns or descriptions

Focus on extracting clear, unambiguous memories. When character names are unclear, use descriptions like "Merchant", "Guard", etc.`;
  }

  /**
   * Get the system prompt that sets up the LLM's role
   */
  private getSystemPrompt(): string {
    return `You are a precise memory extraction system for narrative content. Your job is to identify and structure important memories from chapter synopses.

You extract three types of memories:
1. IC (Inter-Character): Relationships, interactions, and knowledge between characters
   - MUST have both "subjects" and "objects" arrays with character names
   - Example: {"type": "IC", "subjects": ["Alice"], "objects": ["Bob"], "predicate": "trusts"}

2. C2U (Character-to-User): What characters know, think, or feel about the user/player
   - MUST have "subjects" array with character names
   - NO "objects" field (omit it completely)
   - Example: {"type": "C2U", "subjects": ["Alice"], "predicate": "trusts"}

3. WM (World Memory): World state, events, locations, and environmental changes
   - MUST have "subjects" array (can be places, concepts, or characters)
   - NO "objects" field (omit it completely)
   - Example: {"type": "WM", "subjects": ["Kingdom"], "predicate": "world_alert"}

CRITICAL VALIDATION RULES:
- The "subjects" array must NEVER be empty []
- For IC memories: both "subjects" and "objects" are required and non-empty
- For C2U and WM memories: only "subjects" is required, do NOT include "objects"
- Predicates should be clear, descriptive verbs or relationship types
- All strings must be non-empty

Be conservative - only extract clear, unambiguous memories. Use appropriate predicates that best describe the relationship or action.

Always return valid JSON that passes all validation rules.`;
  }

  /**
   * Parse and validate the LLM response
   */
  public parseAndValidateResponse(response: string, chapterNumber: number): StructuredMemory[] {
    let parsedResponse: LLMResponse;
    
    try {
      parsedResponse = JSON.parse(response);
    } catch (error) {
      throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : 'Unknown parsing error'}`);
    }

    if (!parsedResponse.memories || !Array.isArray(parsedResponse.memories)) {
      throw new Error('Response missing "memories" array');
    }

    const validatedMemories: StructuredMemory[] = [];
    const errors: string[] = [];

    for (let i = 0; i < parsedResponse.memories.length; i++) {
      const memory = parsedResponse.memories[i];
      
      try {
        const validatedMemory = this.validateSingleMemory(memory, chapterNumber);
        validatedMemories.push(validatedMemory);
      } catch (error) {
        errors.push(`Memory ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (errors.length > 0) {
      console.warn(`Memory validation errors in chapter ${chapterNumber}:`, errors);
      
      // If too many memories are failing validation, provide additional guidance
      if (errors.length >= parsedResponse.memories.length && parsedResponse.memories.length > 1) {
        console.warn(`⚠️  All ${parsedResponse.memories.length} memories failed validation. Common fixes:`);
        console.warn(`   • Ensure 'subjects' is non-empty array with character names`);
        console.warn(`   • For IC memories: include both subjects AND objects`);
        console.warn(`   • Use clear, descriptive predicates (verbs or relationship types)`);
      }
    }

    return validatedMemories;
  }

  /**
   * Validate a single memory object
   */
  private validateSingleMemory(memory: any, chapterNumber: number): StructuredMemory {
    // Required fields validation
    if (!memory.type || !isValidMemoryType(memory.type)) {
      throw new Error(`Invalid or missing memory type: ${memory.type}`);
    }

    if (!memory.predicate || !isValidPredicate(memory.predicate)) {
      throw new Error(`Invalid or missing predicate: ${memory.predicate}`);
    }

    if (!memory.subjects || !Array.isArray(memory.subjects) || memory.subjects.length === 0) {
      throw new Error('Missing or empty subjects array');
    }

    if (!memory.canonical_fact || typeof memory.canonical_fact !== 'string') {
      throw new Error('Missing or invalid canonical_fact');
    }

    if (!memory.raw_content || typeof memory.raw_content !== 'string') {
      throw new Error('Missing or invalid raw_content');
    }

    if (typeof memory.confidence !== 'number' || memory.confidence < MIN_CONFIDENCE_SCORE || memory.confidence > 1.0) {
      throw new Error(`Invalid confidence score: ${memory.confidence}. Must be between ${MIN_CONFIDENCE_SCORE} and 1.0`);
    }

    // Type-specific validation
    if (memory.type === 'IC') {
      if (!memory.objects || !Array.isArray(memory.objects) || memory.objects.length === 0) {
        throw new Error('IC memories must have objects array with at least one character');
      }
    }

    // Entity name validation
    const allEntities = [...memory.subjects, ...(memory.objects || [])];
    for (const entity of allEntities) {
      if (typeof entity !== 'string' || entity.trim().length === 0) {
        throw new Error(`Invalid entity name: ${entity}`);
      }
    }

    // Normalize entity names
    const normalizedSubjects = memory.subjects.map((name: string) => this.normalizeEntityName(name));
    const normalizedObjects = memory.objects ? memory.objects.map((name: string) => this.normalizeEntityName(name)) : undefined;

    return {
      type: memory.type as MemoryType,
      predicate: memory.predicate as ValidPredicate,
      subjects: normalizedSubjects,
      objects: normalizedObjects,
      canonical_fact: memory.canonical_fact.trim(),
      raw_content: memory.raw_content.trim(),
      confidence: memory.confidence,
      valid_from: chapterNumber
    };
  }

  /**
   * Normalize entity names for consistency
   */
  private normalizeEntityName(name: string): string {
    return name.trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Extract unique entities from a list of memories
   */
  public extractUniqueEntities(memories: StructuredMemory[]): string[] {
    const entities = new Set<string>();
    
    for (const memory of memories) {
      memory.subjects.forEach(subject => entities.add(subject));
      if (memory.objects) {
        memory.objects.forEach(object => entities.add(object));
      }
    }
    
    return Array.from(entities).sort();
  }


  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test the LLM connection and basic functionality
   */
  public async testConnection(): Promise<boolean> {
    try {
      const testRequest: LLMExtractionRequest = {
        chapterNumber: 1,
        synopsis: 'Alice met Bob in the garden. She trusted him with her secret.'
      };

      const result = await this.extractMemories(testRequest);
      return result.memoriesExtracted.length > 0;
    } catch (error) {
      console.error('LLM connection test failed:', error);
      return false;
    }
  }

  /**
   * Get extraction statistics for monitoring
   */
  public getExtractionStats() {
    return {
      maxRetries: this.maxRetries,
      baseDelay: this.baseDelay,
      model: this.model
    };
  }

  /**
   * Create an LLMExtractor instance using the application configuration
   */
  public static fromConfig(): LLMExtractor {
    return new LLMExtractor(
      config.llm.apiKey,
      3, // Default max retries
      1000, // Default base delay
      config.llm.model
    );
  }
}