# Sekai Memory System

A memory management system for multi-character narratives with LLM extraction, conflict resolution, and semantic retrieval.

## Tech Stack & Structure

**Stack:** TypeScript, SQLite, OpenAI API, Express.js

**Project Structure:**
```
src/
├── api/          # REST API server
├── scripts/      # CLI tools (retrieve, evaluate, generate)
├── services/     # Core logic (LLM, Memory, Evaluation)
├── storage/      # Database layer (SQLite)
├── types/        # TypeScript interfaces
└── utils/        # Helpers (config, similarity, validation)
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   # Create .env file with your OpenAI API key
   echo "OPENAI_API_KEY=your_key_here" > .env
   echo "LLM_MODEL=gpt-4o" >> .env
   ```

3. **Initialize database** (optional - auto-created on first use)
   ```bash
   npm run reset-database
   ```

4. **Start API server**
   ```bash
   npm run dev  # Runs on http://localhost:3000
   ```

## Key Commands

### Data Pipeline
- `npm run generate-gold-facts` - Extract gold facts from chapters
- `npm run generate-test-cases` - Generate test queries from gold facts
- `npm run evaluate-entailment` - Run entailment-based evaluation

### Memory Operations
- `npm run retrieve "<query>"` - Query memory system
- `npm run reset-database` - Clear and reset database with memory_data.json

## Memory Retrieval CLI

```bash
# Basic query
npm run retrieve "What is Byleth's relationship with Dimitri?"

# Filter by chapter
npm run retrieve "Show memories" --chapter 5

# Filter by character
npm run retrieve "relationships" --character Sylvain --limit 5
```

## Documentation Files

### `evaluation_summary.md`
Contains the results from the entailment-based evaluation:
- Test case performance metrics (precision, true positive rate)
- Entailment distribution (entails vs contradicts vs unrelated)
- Stale@K metrics for outdated information detection

### `reports/memory-update-report-*.md`
Generated after memory ingestion, shows:
- Number of memories created/superseded
- Entities discovered during processing
- Processing time and statistics

## Evaluation Results & Analysis

### Current Performance
- **Precision: 9.5%** - Low due to retrieval returning many unrelated memories
- **True Positive Rate: 185%** - Exceeds 100% because multiple retrieved memories can entail the same gold fact*
- **Stale@K: 22%** - Moderate level of outdated/contradicting information

*Why >100%? Our evaluation performs N×M comparisons (N retrieved memories × M expected gold facts). When multiple retrieved memories correctly answer the same gold fact, each counts as a true positive. This indicates good recall but redundant retrieval.

### Key Assumptions
1. **Broad Retrieval**: System retrieves up to 20 memories per query for comprehensive coverage
2. **Strict Entailment**: LLM judge uses strict criteria - only exact matches count as "entails"
3. **Many-to-Many Evaluation**: Each retrieved memory is compared against ALL expected gold facts

### Why Low Precision?
- **Cartesian Product Evaluation**: With 20 retrievals × 1-3 gold facts = 20-60 comparisons per query
- **Generic Queries**: Test queries like "Show relationships" return many valid but non-specific memories
- **Semantic Gap**: Retrieved canonical facts may be correct but phrased differently than gold facts

### Next Steps for Improvement
1. **Tune Retrieval**: Reduce limit, increase similarity threshold
2. **Query Refinement**: More specific test queries with entity names
3. **Embedding Enhancement**: Fine-tune embeddings for narrative domain
4. **Hybrid Scoring**: Combine semantic similarity with entity matching
5. **Temporal Weighting**: Prioritize more recent memories in scoring

## License

MIT