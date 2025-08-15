import OpenAI from 'openai';
import { Memory } from '../types';
import { config } from '../utils/config';

/**
 * Entailment judgment result
 */
export type EntailmentJudgment = 'entails' | 'contradicts' | 'unrelated';

/**
 * Test case interface for evaluation
 */
export interface TestCase {
  id: string;
  chapter: number;
  focusCharacter?: string;
  partner?: string;
  query: string;
  expectedGoldIds: string[];
  negativeGoldIds?: string[];
}

/**
 * Gold fact interface for evaluation
 */
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

/**
 * Entailment evaluation result for a single retrieved fact vs gold fact
 */
export interface EntailmentEvaluation {
  retrievedFact: string;
  goldFact: string;
  goldFactId: string;
  judgment: EntailmentJudgment;
  reasoning: string;
}

/**
 * Test case evaluation result
 */
export interface TestCaseResult {
  testCase: TestCase;
  retrievedMemories: Memory[];
  entailmentEvaluations: EntailmentEvaluation[];
  truePositives: number;
  contradictions: number;
  unrelated: number;
  precision: number;  // TP / (TP + contradictions + unrelated)
  staleAtK: number;   // contradictions / total_expected
  executionTime: number;
}

/**
 * Response format from LLM for entailment evaluation
 */
interface EntailmentResponse {
  judgment: EntailmentJudgment;
  reasoning: string;
}

/**
 * Service for evaluating entailment between retrieved memories and gold facts
 */
export class LLMEvaluator {
  private openai: OpenAI;
  private maxRetries: number;
  private baseDelay: number;
  private model: string;

  constructor(
    apiKey: string,
    maxRetries: number = 3,
    baseDelay: number = 1000,
    model: string = 'gpt-4o'
  ) {
    this.openai = new OpenAI({ apiKey });
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
    this.model = model;
  }

  /**
   * Evaluate a test case using entailment-based evaluation
   */
  public async evaluateTestCase(
    testCase: TestCase,
    retrievedMemories: Memory[],
    goldFacts: GoldFact[]
  ): Promise<TestCaseResult> {
    const startTime = Date.now();

    // Get expected gold facts for this test case
    const expectedGoldFacts = goldFacts.filter(gf => testCase.expectedGoldIds.includes(gf.id));
    
    const entailmentEvaluations: EntailmentEvaluation[] = [];
    
    // For each retrieved memory, evaluate against each expected gold fact
    for (const memory of retrievedMemories) {
      for (const goldFact of expectedGoldFacts) {
        const evaluation = await this.evaluateEntailment(
          testCase.query,
          testCase.chapter,
          memory.canonical_fact,
          goldFact.canonical_fact,
          goldFact.id
        );
        entailmentEvaluations.push(evaluation);
      }
    }

    // Calculate metrics
    const truePositives = entailmentEvaluations.filter(e => e.judgment === 'entails').length;
    const contradictions = entailmentEvaluations.filter(e => e.judgment === 'contradicts').length;
    const unrelated = entailmentEvaluations.filter(e => e.judgment === 'unrelated').length;
    
    const totalEvaluations = entailmentEvaluations.length;
    const precision = totalEvaluations > 0 ? truePositives / totalEvaluations : 0;
    const staleAtK = expectedGoldFacts.length > 0 ? contradictions / expectedGoldFacts.length : 0;

    return {
      testCase,
      retrievedMemories,
      entailmentEvaluations,
      truePositives,
      contradictions,
      unrelated,
      precision,
      staleAtK,
      executionTime: Date.now() - startTime
    };
  }

  /**
   * Evaluate entailment between a retrieved fact and gold fact
   */
  private async evaluateEntailment(
    query: string,
    chapter: number,
    retrievedFact: string,
    goldFact: string,
    goldFactId: string
  ): Promise<EntailmentEvaluation> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const prompt = this.buildEntailmentPrompt(query, chapter, retrievedFact, goldFact);
        
        const completion = await this.openai.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: this.getEntailmentSystemPrompt()
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0, // Deterministic evaluation
          max_completion_tokens: 300,
          response_format: { type: "json_object" }
        });

        const responseText = completion.choices[0]?.message?.content;
        if (!responseText) {
          throw new Error('Empty response from LLM');
        }

        const response = this.parseEntailmentResponse(responseText);
        
        return {
          retrievedFact,
          goldFact,
          goldFactId,
          judgment: response.judgment,
          reasoning: response.reasoning
        };

      } catch (error) {
        lastError = error as Error;
        console.warn(`Entailment evaluation attempt ${attempt} failed:`, error);
        
        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Entailment evaluation failed after ${this.maxRetries} attempts. Last error: ${lastError?.message}`);
  }

  /**
   * Build the prompt for entailment evaluation
   */
  private buildEntailmentPrompt(
    query: string,
    chapter: number,
    retrievedFact: string,
    goldFact: string
  ): string {
    return `Given a query at a specific chapter, evaluate whether a retrieved fact fully answers the question implied by a gold fact.

QUERY: "${query}"
CHAPTER: ${chapter}

RETRIEVED_FACT: "${retrievedFact}"
GOLD_FACT: "${goldFact}"

Question: Given Query Q at chapter C, does RETRIEVED_FACT fully answer the question implied by GOLD_FACT?

Your task is to determine the relationship between the retrieved fact and gold fact in the context of answering the query:

- **entails**: The retrieved fact fully answers or satisfies what the gold fact represents. The retrieved information contains or implies the gold fact's content.

- **contradicts**: The retrieved fact contradicts the gold fact or provides outdated/incorrect information that conflicts with what should be the current state. This often indicates stale information from an earlier state.

- **unrelated**: The retrieved fact is unrelated to the gold fact or doesn't help answer the question implied by the gold fact.

Consider:
1. Does the retrieved fact contain the same information as the gold fact?
2. Does the retrieved fact answer the same underlying question?
3. Are there any contradictions in the factual content?
4. Is the information from the right time period/chapter?

Return your judgment as JSON with "judgment" (one of: entails, contradicts, unrelated) and "reasoning" (brief explanation).`;
  }

  /**
   * Get the system prompt for entailment evaluation
   */
  private getEntailmentSystemPrompt(): string {
    return `You are a precise entailment evaluation system for memory retrieval. Your job is to determine whether retrieved facts adequately answer questions implied by gold standard facts.

You must make precise judgments about:
1. **entails**: Retrieved fact fully satisfies/answers what the gold fact represents
2. **contradicts**: Retrieved fact conflicts with or provides outdated information relative to the gold fact
3. **unrelated**: Retrieved fact doesn't address the same question/topic as the gold fact

Be strict and precise in your evaluation. Focus on whether the retrieved information actually answers the underlying question that the gold fact represents.

Always return valid JSON with exactly the requested fields: "judgment" and "reasoning".`;
  }

  /**
   * Parse and validate the entailment response
   */
  private parseEntailmentResponse(response: string): EntailmentResponse {
    let parsedResponse: any;
    
    try {
      parsedResponse = JSON.parse(response);
    } catch (error) {
      throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : 'Unknown parsing error'}`);
    }

    // Validate judgment field
    if (!parsedResponse.judgment || 
        !['entails', 'contradicts', 'unrelated'].includes(parsedResponse.judgment)) {
      throw new Error(`Invalid judgment: ${parsedResponse.judgment}. Must be one of: entails, contradicts, unrelated`);
    }

    // Validate reasoning field
    if (!parsedResponse.reasoning || typeof parsedResponse.reasoning !== 'string') {
      throw new Error('Missing or invalid reasoning field');
    }

    return {
      judgment: parsedResponse.judgment as EntailmentJudgment,
      reasoning: parsedResponse.reasoning.trim()
    };
  }

  /**
   * Create a default instance from config
   */
  public static fromConfig(): LLMEvaluator {
    return new LLMEvaluator(
      config.llm.apiKey,
      3, // maxRetries
      1000, // baseDelay
      'gpt-4o' // model for evaluation
    );
  }
}