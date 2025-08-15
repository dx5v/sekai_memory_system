import { RetrievalContext } from '../types';
import { MemoryService } from './MemoryService';
import { 
  LLMEvaluator, 
  TestCase, 
  GoldFact, 
  TestCaseResult,
  EntailmentEvaluation
} from './LLMEvaluator';

/**
 * Configuration for entailment-based evaluation pipeline
 */
export interface EvaluationConfig {
  retrievalLimit: number;             // max memories to retrieve per query
  retrievalThreshold: number;         // minimum similarity threshold for retrieval
  verbose: boolean;                   // whether to log detailed progress
  maxConcurrentEvaluations: number;   // max test cases to process in parallel
}

/**
 * Overall evaluation result across all test cases
 */
export interface EvaluationResult {
  testCaseResults: TestCaseResult[];
  overallMetrics: {
    totalTestCases: number;
    totalRetrievals: number;
    totalEntailmentEvaluations: number;
    avgTruePositives: number;         // Average TP per test case
    avgContradictions: number;        // Average contradictions per test case
    avgUnrelated: number;             // Average unrelated per test case
    avgPrecision: number;             // Average precision across test cases
    avgStaleAtK: number;              // Average Stale@K across test cases
    truePositiveRate: number;         // Total TPs / Total expected golds
    contradictionRate: number;        // Total contradictions / Total expected golds
  };
  executionTime: number;
}

/**
 * Pipeline that orchestrates entailment-based evaluation of memory retrieval
 */
export class EvaluationPipeline {
  private evaluator: LLMEvaluator;
  private memoryService: MemoryService;
  private config: EvaluationConfig;

  constructor(
    evaluator: LLMEvaluator,
    memoryService: MemoryService,
    config: EvaluationConfig
  ) {
    this.evaluator = evaluator;
    this.memoryService = memoryService;
    this.config = config;
  }

  /**
   * Run complete entailment-based evaluation on test cases
   */
  public async evaluateTestCases(
    testCases: TestCase[], 
    goldFacts: GoldFact[]
  ): Promise<EvaluationResult> {
    const startTime = Date.now();
    
    if (this.config.verbose) {
      console.log(`🔍 Starting entailment-based evaluation on ${testCases.length} test cases...`);
      console.log(`   Using ${goldFacts.length} gold facts as ground truth`);
      console.log(`   Retrieving up to ${this.config.retrievalLimit} memories per query`);
    }

    const testCaseResults: TestCaseResult[] = [];

    // Process test cases in batches to avoid overwhelming the LLM API
    const batchSize = this.config.maxConcurrentEvaluations;
    
    for (let i = 0; i < testCases.length; i += batchSize) {
      const batch = testCases.slice(i, i + batchSize);
      
      if (this.config.verbose) {
        console.log(`  📝 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(testCases.length / batchSize)} (${batch.length} test cases)`);
      }

      // Process test cases in parallel within each batch
      const batchPromises = batch.map(testCase => this.evaluateTestCase(testCase, goldFacts));
      const batchResults = await Promise.allSettled(batchPromises);

      // Collect successful results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          testCaseResults.push(result.value);
        } else {
          console.warn('Test case evaluation failed:', result.reason);
        }
      }

      if (this.config.verbose) {
        const batchPrecision = testCaseResults.length > 0 
          ? testCaseResults.slice(-batch.length).reduce((sum, r) => sum + r.precision, 0) / batch.length
          : 0;
        console.log(`    Batch avg precision: ${(batchPrecision * 100).toFixed(1)}%`);
      }
    }

    // Calculate overall metrics
    const result = this.calculateOverallMetrics(testCaseResults, Date.now() - startTime);

    if (this.config.verbose) {
      console.log(`✅ Evaluation completed in ${result.executionTime}ms`);
      console.log(`   Overall Precision: ${(result.overallMetrics.avgPrecision * 100).toFixed(1)}%`);
      console.log(`   True Positive Rate: ${(result.overallMetrics.truePositiveRate * 100).toFixed(1)}%`);
      console.log(`   Stale@K Rate: ${(result.overallMetrics.avgStaleAtK * 100).toFixed(1)}%`);
      console.log(`   Contradiction Rate: ${(result.overallMetrics.contradictionRate * 100).toFixed(1)}%`);
    }

    return result;
  }

  /**
   * Evaluate a single test case
   */
  private async evaluateTestCase(testCase: TestCase, goldFacts: GoldFact[]): Promise<TestCaseResult> {
    // Build retrieval context from test case
    const retrievalContext: RetrievalContext = {
      query: testCase.query,
      limit: this.config.retrievalLimit,
      threshold: this.config.retrievalThreshold,
      filters: {
        // Apply chapter filter if specified
        chapterNumber: testCase.chapter
      }
    };

    // Retrieve memories using the existing memory service
    const retrievalResult = await this.memoryService.retrieveMemories(retrievalContext);
    
    // Evaluate the retrieved memories using entailment-based evaluation
    const testCaseResult = await this.evaluator.evaluateTestCase(testCase, retrievalResult.memories, goldFacts);

    return testCaseResult;
  }

  /**
   * Calculate overall metrics from all test case results
   */
  private calculateOverallMetrics(
    testCaseResults: TestCaseResult[],
    executionTime: number
  ): EvaluationResult {
    if (testCaseResults.length === 0) {
      return {
        testCaseResults: [],
        overallMetrics: {
          totalTestCases: 0,
          totalRetrievals: 0,
          totalEntailmentEvaluations: 0,
          avgTruePositives: 0,
          avgContradictions: 0,
          avgUnrelated: 0,
          avgPrecision: 0,
          avgStaleAtK: 0,
          truePositiveRate: 0,
          contradictionRate: 0
        },
        executionTime
      };
    }

    const totalTestCases = testCaseResults.length;
    const totalRetrievals = testCaseResults.reduce((sum, r) => sum + r.retrievedMemories.length, 0);
    const totalEntailmentEvaluations = testCaseResults.reduce((sum, r) => sum + r.entailmentEvaluations.length, 0);
    
    // Sum across all test cases
    const totalTruePositives = testCaseResults.reduce((sum, r) => sum + r.truePositives, 0);
    const totalContradictions = testCaseResults.reduce((sum, r) => sum + r.contradictions, 0);
    const totalUnrelated = testCaseResults.reduce((sum, r) => sum + r.unrelated, 0);
    
    // Sum of precision and stale@k for averaging
    const totalPrecision = testCaseResults.reduce((sum, r) => sum + r.precision, 0);
    const totalStaleAtK = testCaseResults.reduce((sum, r) => sum + r.staleAtK, 0);
    
    // Calculate expected gold facts across all test cases
    const totalExpectedGolds = testCaseResults.reduce((sum, r) => sum + r.testCase.expectedGoldIds.length, 0);

    return {
      testCaseResults,
      overallMetrics: {
        totalTestCases,
        totalRetrievals,
        totalEntailmentEvaluations,
        avgTruePositives: totalTestCases > 0 ? totalTruePositives / totalTestCases : 0,
        avgContradictions: totalTestCases > 0 ? totalContradictions / totalTestCases : 0,
        avgUnrelated: totalTestCases > 0 ? totalUnrelated / totalTestCases : 0,
        avgPrecision: totalTestCases > 0 ? totalPrecision / totalTestCases : 0,
        avgStaleAtK: totalTestCases > 0 ? totalStaleAtK / totalTestCases : 0,
        truePositiveRate: totalExpectedGolds > 0 ? totalTruePositives / totalExpectedGolds : 0,
        contradictionRate: totalExpectedGolds > 0 ? totalContradictions / totalExpectedGolds : 0
      },
      executionTime
    };
  }

  /**
   * Create a default pipeline instance from config
   */
  public static fromConfig(
    memoryService: MemoryService,
    config: Partial<EvaluationConfig> = {}
  ): EvaluationPipeline {
    const defaultConfig: EvaluationConfig = {
      retrievalLimit: 20,
      retrievalThreshold: 0.3,
      verbose: false,
      maxConcurrentEvaluations: 3,
      ...config
    };

    const evaluator = LLMEvaluator.fromConfig();

    return new EvaluationPipeline(
      evaluator,
      memoryService,
      defaultConfig
    );
  }
}