/**
 * Memory Update Reporter
 * 
 * Generates detailed reports of how memories change during chapter insertion,
 * tracking creation, supersession, duplication, and entity resolution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { 
  Memory, 
  StructuredMemory, 
  IngestResult
} from '../types';

/**
 * Types for tracking memory changes
 */
export interface MemoryChange {
  timestamp: Date;
  chapterNumber: number;
  action: 'created' | 'superseded' | 'duplicate' | 'error';
  memory: {
    id?: string | undefined;
    type: string;
    predicate: string;
    subjects: string[];
    objects?: string[] | undefined;
    canonical_fact: string;
    confidence: number;
  };
  previousMemory?: {
    id: string;
    canonical_fact: string;
    valid_from: number;
    valid_to: number | null;
  };
  reason?: string | undefined;
}

export interface EntityChange {
  timestamp: Date;
  chapterNumber: number;
  action: 'created' | 'resolved';
  entity: {
    id?: string;
    name: string;
    kind: string;
    aliases?: string[];
  };
}

export interface ChapterProcessingReport {
  chapterNumber: number;
  startTime: Date;
  endTime: Date;
  processingTime: number;
  memoriesExtracted: number;
  memoryChanges: MemoryChange[];
  entityChanges: EntityChange[];
  storeStateBefore: {
    totalMemories: number;
    activeMemories: number;
    supersededMemories: number;
    totalEntities: number;
  };
  storeStateAfter: {
    totalMemories: number;
    activeMemories: number;
    supersededMemories: number;
    totalEntities: number;
  };
  errors: string[];
}

export interface FullIngestionReport {
  startTime: Date;
  endTime: Date;
  totalProcessingTime: number;
  chaptersProcessed: number;
  chapterReports: ChapterProcessingReport[];
  summary: {
    totalMemoriesCreated: number;
    totalMemoriesSuperseded: number;
    totalDuplicatesSkipped: number;
    totalEntitiesCreated: number;
    totalErrors: number;
    conflictPatterns: ConflictPattern[];
    entityGrowth: EntityGrowthMetric[];
  };
}

export interface ConflictPattern {
  entities: string;
  predicate: string;
  changes: Array<{
    chapter: number;
    from: string;
    to: string;
  }>;
}

export interface EntityGrowthMetric {
  chapter: number;
  totalEntities: number;
  newEntities: number;
  entityNames: string[];
}

/**
 * Service for generating memory update reports
 */
export class MemoryUpdateReporter {
  private currentReport: FullIngestionReport | null = null;
  private currentChapterReport: ChapterProcessingReport | null = null;
  private reportPath: string;
  private conflictTracking: Map<string, ConflictPattern> = new Map();

  constructor(reportDir: string = './reports') {
    // Ensure report directory exists
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    
    // Generate timestamped report filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.reportPath = path.join(reportDir, `memory-update-report-${timestamp}.json`);
  }

  /**
   * Start tracking a new ingestion session
   */
  public startIngestionTracking(): void {
    this.currentReport = {
      startTime: new Date(),
      endTime: new Date(),
      totalProcessingTime: 0,
      chaptersProcessed: 0,
      chapterReports: [],
      summary: {
        totalMemoriesCreated: 0,
        totalMemoriesSuperseded: 0,
        totalDuplicatesSkipped: 0,
        totalEntitiesCreated: 0,
        totalErrors: 0,
        conflictPatterns: [],
        entityGrowth: []
      }
    };
    
    this.conflictTracking.clear();
    console.log(`📝 Memory update tracking started. Report will be saved to: ${this.reportPath}`);
  }

  /**
   * Start tracking a chapter processing
   */
  public startChapterTracking(
    chapterNumber: number,
    storeStateBefore: {
      totalMemories: number;
      activeMemories: number;
      supersededMemories: number;
      totalEntities: number;
    }
  ): void {
    this.currentChapterReport = {
      chapterNumber,
      startTime: new Date(),
      endTime: new Date(),
      processingTime: 0,
      memoriesExtracted: 0,
      memoryChanges: [],
      entityChanges: [],
      storeStateBefore,
      storeStateAfter: storeStateBefore, // Will be updated at end
      errors: []
    };
  }

  /**
   * Track a memory change
   */
  public trackMemoryChange(
    action: 'created' | 'superseded' | 'duplicate' | 'error',
    memory: StructuredMemory,
    memoryId?: string,
    previousMemory?: Memory,
    reason?: string
  ): void {
    if (!this.currentChapterReport) return;

    const change: MemoryChange = {
      timestamp: new Date(),
      chapterNumber: this.currentChapterReport.chapterNumber,
      action,
      memory: {
        id: memoryId,
        type: memory.type,
        predicate: memory.predicate,
        subjects: memory.subjects,
        objects: memory.objects,
        canonical_fact: memory.canonical_fact,
        confidence: memory.confidence
      },
      reason
    };

    // Add previous memory info for supersession
    if (previousMemory && action === 'superseded') {
      change.previousMemory = {
        id: previousMemory.id,
        canonical_fact: previousMemory.canonical_fact,
        valid_from: previousMemory.valid_from,
        valid_to: previousMemory.valid_to || null
      };

      // Track conflict pattern
      this.trackConflictPattern(memory, previousMemory);
    }

    this.currentChapterReport.memoryChanges.push(change);
  }

  /**
   * Track an entity change
   */
  public trackEntityChange(
    action: 'created' | 'resolved',
    entity: { id?: string; name: string; kind: string; aliases?: string[] }
  ): void {
    if (!this.currentChapterReport) return;

    this.currentChapterReport.entityChanges.push({
      timestamp: new Date(),
      chapterNumber: this.currentChapterReport.chapterNumber,
      action,
      entity
    });
  }

  /**
   * Track an error during processing
   */
  public trackError(error: string): void {
    if (!this.currentChapterReport) return;
    this.currentChapterReport.errors.push(error);
  }

  /**
   * Complete chapter tracking
   */
  public completeChapterTracking(
    memoriesExtracted: number,
    storeStateAfter: {
      totalMemories: number;
      activeMemories: number;
      supersededMemories: number;
      totalEntities: number;
    },
    result: IngestResult
  ): void {
    if (!this.currentChapterReport || !this.currentReport) return;

    // Update chapter report
    this.currentChapterReport.endTime = new Date();
    this.currentChapterReport.processingTime = 
      this.currentChapterReport.endTime.getTime() - this.currentChapterReport.startTime.getTime();
    this.currentChapterReport.memoriesExtracted = memoriesExtracted;
    this.currentChapterReport.storeStateAfter = storeStateAfter;

    // Track entity growth
    const entityGrowth = storeStateAfter.totalEntities - this.currentChapterReport.storeStateBefore.totalEntities;
    if (entityGrowth > 0) {
      const newEntityNames = this.currentChapterReport.entityChanges
        .filter(e => e.action === 'created')
        .map(e => e.entity.name);
      
      this.currentReport.summary.entityGrowth.push({
        chapter: this.currentChapterReport.chapterNumber,
        totalEntities: storeStateAfter.totalEntities,
        newEntities: entityGrowth,
        entityNames: newEntityNames
      });
    }

    // Update summary
    this.currentReport.summary.totalMemoriesCreated += result.memoriesCreated;
    this.currentReport.summary.totalMemoriesSuperseded += result.memoriesSuperseded;
    this.currentReport.summary.totalDuplicatesSkipped += result.memoriesDuplicated;
    this.currentReport.summary.totalEntitiesCreated += result.entitiesCreated;
    this.currentReport.summary.totalErrors += result.errors.length;

    // Add chapter report to full report
    this.currentReport.chapterReports.push(this.currentChapterReport);
    this.currentReport.chaptersProcessed++;

    // Clear current chapter
    this.currentChapterReport = null;
  }

  /**
   * Complete ingestion tracking and save report
   */
  public async completeIngestionTracking(): Promise<void> {
    if (!this.currentReport) return;

    // Finalize report
    this.currentReport.endTime = new Date();
    this.currentReport.totalProcessingTime = 
      this.currentReport.endTime.getTime() - this.currentReport.startTime.getTime();

    // Add conflict patterns to summary
    this.currentReport.summary.conflictPatterns = Array.from(this.conflictTracking.values());

    // Save JSON report
    await this.saveJSONReport();

    // Generate and save markdown report
    await this.saveMarkdownReport();

    console.log(`\n📊 Memory update report saved to:`);
    console.log(`   JSON: ${this.reportPath}`);
    console.log(`   Markdown: ${this.reportPath.replace('.json', '.md')}`);

    // Clear current report
    this.currentReport = null;
  }

  /**
   * Track conflict patterns for analysis
   */
  private trackConflictPattern(newMemory: StructuredMemory, oldMemory: Memory): void {
    const key = `${newMemory.subjects.join(',')}-${newMemory.predicate}-${newMemory.objects?.join(',') || ''}`;
    
    if (!this.conflictTracking.has(key)) {
      this.conflictTracking.set(key, {
        entities: `${newMemory.subjects.join(', ')} → ${newMemory.objects?.join(', ') || 'N/A'}`,
        predicate: newMemory.predicate,
        changes: []
      });
    }

    const pattern = this.conflictTracking.get(key)!;
    pattern.changes.push({
      chapter: newMemory.valid_from,
      from: oldMemory.canonical_fact,
      to: newMemory.canonical_fact
    });
  }

  /**
   * Save the report as JSON
   */
  private async saveJSONReport(): Promise<void> {
    if (!this.currentReport) return;

    const jsonContent = JSON.stringify(this.currentReport, null, 2);
    fs.writeFileSync(this.reportPath, jsonContent);
  }

  /**
   * Generate and save a markdown version of the report
   */
  private async saveMarkdownReport(): Promise<void> {
    if (!this.currentReport) return;

    const mdPath = this.reportPath.replace('.json', '.md');
    const report = this.currentReport;

    let markdown = `# Memory Update Report\n\n`;
    markdown += `**Generated:** ${report.endTime.toISOString()}\n`;
    markdown += `**Processing Time:** ${(report.totalProcessingTime / 1000).toFixed(2)}s\n`;
    markdown += `**Chapters Processed:** ${report.chaptersProcessed}\n\n`;

    // Summary Statistics
    markdown += `## Summary Statistics\n\n`;
    markdown += `| Metric | Count |\n`;
    markdown += `|--------|-------|\n`;
    markdown += `| Memories Created | ${report.summary.totalMemoriesCreated} |\n`;
    markdown += `| Memories Superseded | ${report.summary.totalMemoriesSuperseded} |\n`;
    markdown += `| Duplicates Skipped | ${report.summary.totalDuplicatesSkipped} |\n`;
    markdown += `| Entities Created | ${report.summary.totalEntitiesCreated} |\n`;
    markdown += `| Total Errors | ${report.summary.totalErrors} |\n\n`;

    // Conflict Patterns
    if (report.summary.conflictPatterns.length > 0) {
      markdown += `## Conflict Patterns\n\n`;
      for (const pattern of report.summary.conflictPatterns) {
        markdown += `### ${pattern.entities} (${pattern.predicate})\n`;
        for (const change of pattern.changes) {
          markdown += `- Chapter ${change.chapter}: "${change.from}" → "${change.to}"\n`;
        }
        markdown += `\n`;
      }
    }

    // Entity Growth
    if (report.summary.entityGrowth.length > 0) {
      markdown += `## Entity Discovery Timeline\n\n`;
      markdown += `| Chapter | Total Entities | New | Names |\n`;
      markdown += `|---------|---------------|-----|-------|\n`;
      for (const growth of report.summary.entityGrowth) {
        markdown += `| ${growth.chapter} | ${growth.totalEntities} | +${growth.newEntities} | ${growth.entityNames.join(', ')} |\n`;
      }
      markdown += `\n`;
    }

    // Chapter-by-Chapter Details
    markdown += `## Chapter Processing Details\n\n`;
    for (const chapter of report.chapterReports) {
      markdown += `### Chapter ${chapter.chapterNumber}\n`;
      markdown += `- **Processing Time:** ${chapter.processingTime}ms\n`;
      markdown += `- **Memories Extracted:** ${chapter.memoriesExtracted}\n`;
      markdown += `- **Store Change:** ${chapter.storeStateBefore.totalMemories} → ${chapter.storeStateAfter.totalMemories} memories\n`;
      
      // Memory changes
      const created = chapter.memoryChanges.filter(c => c.action === 'created').length;
      const superseded = chapter.memoryChanges.filter(c => c.action === 'superseded').length;
      const duplicates = chapter.memoryChanges.filter(c => c.action === 'duplicate').length;
      
      if (created > 0) markdown += `  - Created: ${created}\n`;
      if (superseded > 0) markdown += `  - Superseded: ${superseded}\n`;
      if (duplicates > 0) markdown += `  - Duplicates: ${duplicates}\n`;

      // Show supersession details
      const supersessions = chapter.memoryChanges.filter(c => c.action === 'superseded');
      if (supersessions.length > 0) {
        markdown += `  - **Supersessions:**\n`;
        for (const sup of supersessions) {
          markdown += `    - "${sup.previousMemory?.canonical_fact}" → "${sup.memory.canonical_fact}"\n`;
        }
      }

      if (chapter.errors.length > 0) {
        markdown += `  - **Errors:** ${chapter.errors.length}\n`;
      }
      
      markdown += `\n`;
    }

    fs.writeFileSync(mdPath, markdown);
  }

  /**
   * Get the current report (for testing/debugging)
   */
  public getCurrentReport(): FullIngestionReport | null {
    return this.currentReport;
  }

  /**
   * Get the report file path
   */
  public getReportPath(): string {
    return this.reportPath;
  }
}

/**
 * Singleton instance for global access
 */
let reporterInstance: MemoryUpdateReporter | null = null;

export function getMemoryReporter(reportDir?: string): MemoryUpdateReporter {
  if (!reporterInstance) {
    reporterInstance = new MemoryUpdateReporter(reportDir);
  }
  return reporterInstance;
}

export function resetMemoryReporter(): void {
  reporterInstance = null;
}