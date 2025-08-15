import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryService } from '../services/MemoryService';
import { initializeDatabase } from '../storage/database';
import {
  ChapterData,
  ApiResponse,
  IngestRequest,
  MemoryRetrievalRequest,
  IngestResult,
  MemoryPack,
  MemoryError,
  EvaluationMetrics
} from '../types';
import { config, ensureDataDirectory } from '../utils/config';
import {
  ValidationError,
  validateRetrievalRequest,
  validateIngestionRequest,
  validateMemoryDataFile,
  validateRequestRate,
  categorizeError,
  HTTP_STATUS
} from '../utils/validation';

const app = express();

// Global variables
let memoryService: MemoryService;
let isInitialized = false;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Request rate limiting storage
const rateLimitStorage = new Map<string, any>();

// Error handling middleware
const errorHandler = (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API Error:', error);
  
  const timestamp = new Date();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Categorize error for proper handling
  const errorInfo = categorizeError(error);
  
  const errorResponse: ApiResponse<null> = {
    success: false,
    error: {
      type: errorInfo.type,
      message: error.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp,
      retryable: errorInfo.isRetryable
    } as MemoryError,
    meta: {
      requestId,
      timestamp,
      executionTime: 0
    }
  };
  
  res.status(errorInfo.status).json(errorResponse);
};

// Rate limiting middleware
const rateLimitMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const endpoint = req.path.replace('/', '');
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  
  const rateLimit = validateRequestRate(clientIp, endpoint, rateLimitStorage);
  
  // Add rate limit headers
  res.set({
    'X-RateLimit-Remaining': rateLimit.remaining.toString(),
    'X-RateLimit-Reset': new Date(rateLimit.resetTime).toISOString()
  });
  
  if (!rateLimit.allowed) {
    const error = Object.assign(
      new ValidationError('Rate limit exceeded'), 
      { statusCode: HTTP_STATUS.TOO_MANY_REQUESTS }
    );
    return next(error);
  }
  
  next();
};

// Apply rate limiting to sensitive endpoints
app.use('/ingest', rateLimitMiddleware);
app.use('/memories', rateLimitMiddleware);

// Utility functions removed - validation now handled by validation.ts

// Health check endpoint
app.get('/health', (_req, res) => {
  const response: ApiResponse<{ status: string; initialized: boolean }> = {
    success: true,
    data: {
      status: 'healthy',
      initialized: isInitialized
    },
    meta: {
      requestId: `health_${Date.now()}`,
      timestamp: new Date(),
      executionTime: 0
    }
  };
  
  res.json(response);
});

// POST /ingest - Process memory_data.json
app.post('/ingest', async (req: express.Request<{}, ApiResponse<IngestResult>, IngestRequest>, res, next) => {
  const startTime = Date.now();
  const requestId = `ingest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    if (!isInitialized) {
      throw Object.assign(new ValidationError('Service not initialized'), { statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE });
    }

    // Validate request body if provided
    if (req.body && Object.keys(req.body).length > 0) {
      const validation = validateIngestionRequest(req.body);
      if (!validation.isValid) {
        throw Object.assign(
          new ValidationError(`Request validation failed: ${validation.errors.join(', ')}`),
          { statusCode: HTTP_STATUS.BAD_REQUEST }
        );
      }
    }

    // Look for memory_data.json in the project root
    const memoryDataPath = path.join(process.cwd(), 'memory_data.json');
    
    // Validate the memory data file
    const fileValidation = validateMemoryDataFile(memoryDataPath);
    if (!fileValidation.isValid) {
      throw Object.assign(
        new ValidationError(`File validation failed: ${fileValidation.errors.join(', ')}`),
        { statusCode: HTTP_STATUS.BAD_REQUEST }
      );
    }

    console.log(`Reading memory data from: ${memoryDataPath}`);
    const memoryDataContent = fs.readFileSync(memoryDataPath, 'utf-8');
    
    let chapters: ChapterData[];
    try {
      chapters = JSON.parse(memoryDataContent);
    } catch (parseError) {
      throw Object.assign(
        new ValidationError('Invalid JSON in memory_data.json'),
        { statusCode: HTTP_STATUS.BAD_REQUEST }
      );
    }

    // Additional validation for parsed chapters
    const ingestionValidation = validateIngestionRequest(chapters);
    if (!ingestionValidation.isValid) {
      throw Object.assign(
        new ValidationError(`Chapter validation failed: ${ingestionValidation.errors.join(', ')}`),
        { statusCode: HTTP_STATUS.BAD_REQUEST }
      );
    }

    console.log(`Processing ${chapters.length} chapters...`);
    const result = await memoryService.ingestChapters(chapters);

    const response: ApiResponse<IngestResult> = {
      success: true,
      data: result,
      meta: {
        requestId,
        timestamp: new Date(),
        executionTime: Date.now() - startTime
      }
    };

    console.log(`Ingestion completed: ${result.memoriesCreated} memories created, ${result.errors.length} errors`);
    res.json(response);

  } catch (error) {
    console.error('Ingestion error:', error);
    next(error);
  }
});

// GET /memories - Retrieve memories with filtering and search
app.get('/memories', async (req: express.Request<{}, ApiResponse<MemoryPack>, {}, MemoryRetrievalRequest>, res, next) => {
  const startTime = Date.now();
  const requestId = `memories_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    if (!isInitialized) {
      throw Object.assign(
        new ValidationError('Service not initialized'), 
        { statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE }
      );
    }

    // Validate and sanitize query parameters
    const validation = validateRetrievalRequest(req.query);
    if (!validation.isValid) {
      throw Object.assign(
        new ValidationError(`Query validation failed: ${validation.errors.join(', ')}`),
        { statusCode: HTTP_STATUS.BAD_REQUEST }
      );
    }

    const sanitized = validation.sanitized;
    const {
      q: query,
      type,
      characterName,
      chapterNumber,
      chapterRange,
      limit = 50,
      threshold = 0.0
    } = sanitized;

    // Build filters from sanitized input
    const filters: any = {};

    if (type) {
      filters.type = type;
    }

    if (characterName) {
      filters.characterName = characterName;
    }

    if (chapterNumber) {
      filters.chapterNumber = chapterNumber;
    }

    if (chapterRange) {
      filters.chapterRange = chapterRange;
    }

    // Build retrieval context
    const retrievalContext: any = {
      filters,
      limit,
      threshold,
      includeWorldMemories: true
    };
    
    if (query) {
      retrievalContext.query = query;
    }

    console.log(`Retrieving memories with context:`, JSON.stringify(retrievalContext, null, 2));
    const result = await memoryService.retrieveMemories(retrievalContext);

    const response: ApiResponse<MemoryPack> = {
      success: true,
      data: result,
      meta: {
        requestId,
        timestamp: new Date(),
        executionTime: Date.now() - startTime
      }
    };

    console.log(`Retrieved ${result.memories.length} memories (${result.totalCount} total)`);
    res.json(response);

  } catch (error) {
    console.error('Memory retrieval error:', error);
    next(error);
  }
});

// GET /eval - Development-only evaluation metrics
app.get('/eval', async (_req, res, next) => {
  const startTime = Date.now();
  const requestId = `eval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    if (!isInitialized) {
      throw Object.assign(
        new ValidationError('Service not initialized'), 
        { statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE }
      );
    }

    if (config.development.nodeEnv === 'production') {
      throw Object.assign(
        new ValidationError('Evaluation endpoint not available in production'), 
        { statusCode: HTTP_STATUS.NOT_FOUND }
      );
    }

    console.log('Generating evaluation metrics...');

    // Get memory statistics
    const stats = await memoryService.getMemoryStatistics();

    // Create evaluation metrics
    const evaluationMetrics: EvaluationMetrics = {
      consistency: {
        totalMemories: stats.totalMemories,
        conflictingMemories: stats.supersededMemories,
        consistencyScore: stats.totalMemories > 0 ? 
          1 - (stats.supersededMemories / stats.totalMemories) : 1
      },
      coverage: {
        chaptersProcessed: 0, // Would need to track this
        memoriesExtracted: stats.totalMemories,
        averageMemoriesPerChapter: 0, // Would need chapter count
        entitiesDiscovered: stats.entityCount
      },
      performance: {
        averageIngestionTime: 0, // Would need to track this
        averageRetrievalTime: 0, // Would need to track this
        databaseSize: stats.totalMemories
      }
    };

    const response: ApiResponse<EvaluationMetrics> = {
      success: true,
      data: evaluationMetrics,
      meta: {
        requestId,
        timestamp: new Date(),
        executionTime: Date.now() - startTime
      }
    };

    console.log('Evaluation metrics generated');
    res.json(response);

  } catch (error) {
    console.error('Evaluation error:', error);
    next(error);
  }
});

// GET /stats - Memory system statistics
app.get('/stats', async (_req, res, next) => {
  const startTime = Date.now();
  const requestId = `stats_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    if (!isInitialized) {
      throw Object.assign(
        new ValidationError('Service not initialized'), 
        { statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE }
      );
    }

    const stats = await memoryService.getMemoryStatistics();

    const response: ApiResponse<typeof stats> = {
      success: true,
      data: stats,
      meta: {
        requestId,
        timestamp: new Date(),
        executionTime: Date.now() - startTime
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Stats error:', error);
    next(error);
  }
});

// 404 handler
app.use('*', (req, res) => {
  const response: ApiResponse<null> = {
    success: false,
    error: {
      type: 'validation',
      message: `Endpoint not found: ${req.method} ${req.originalUrl}`,
      timestamp: new Date(),
      retryable: false
    } as MemoryError,
    meta: {
      requestId: `404_${Date.now()}`,
      timestamp: new Date(),
      executionTime: 0
    }
  };

  res.status(HTTP_STATUS.NOT_FOUND).json(response);
});

// Apply error handling middleware
app.use(errorHandler);

// Server initialization
async function initializeServer(): Promise<void> {
  try {
    console.log('Initializing Sekai Memory System...');
    
    // Ensure data directory exists
    ensureDataDirectory();
    
    // Initialize database
    await initializeDatabase(config.storage.databasePath);
    console.log('✓ Database initialized');
    
    // Initialize memory service
    memoryService = MemoryService.fromConfig();
    console.log('✓ Memory service initialized');
    
    isInitialized = true;
    console.log('✓ Server initialization complete');
    
  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  }
}

// Start server
async function startServer(): Promise<void> {
  await initializeServer();
  
  const port = config.api.port;
  const host = config.api.host;
  
  app.listen(port, host, () => {
    console.log(`🚀 Sekai Memory System API running on http://${host}:${port}`);
    console.log(`📊 Health check: http://${host}:${port}/health`);
    console.log(`💾 Memory ingestion: POST http://${host}:${port}/ingest`);
    console.log(`🔍 Memory retrieval: GET http://${host}:${port}/memories`);
    console.log(`📈 System stats: GET http://${host}:${port}/stats`);
    
    if (config.development.nodeEnv !== 'production') {
      console.log(`🧪 Evaluation metrics: GET http://${host}:${port}/eval`);
    }
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Export for testing
export { app, initializeServer };

// Start server if this file is run directly
if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}