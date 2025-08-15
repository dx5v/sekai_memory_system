# Entailment-Based Evaluation Report

## Overview
- **Evaluation Method**: Entailment-based using LLM judge
- **Test Cases Evaluated**: 327
- **Execution Time**: 6095.3 seconds
- **Total Retrievals**: 6154
- **Total Entailment Evaluations**: 5532

## Key Metrics

### Entailment Distribution
- **True Positives (entails)**: 1.66 per test case
- **Contradictions**: 0.22 per test case
- **Unrelated**: 15.03 per test case

### Performance Metrics
- **Average Precision**: 9.5%
- **True Positive Rate**: 185.0%
- **Stale@K (contradiction rate)**: 22.0%
- **Overall Contradiction Rate**: 24.5%

## Evaluation Approach

This evaluation uses entailment-based scoring where:

1. **Query Execution**: Each test case query is executed against the memory retrieval system
2. **Entailment Evaluation**: For each retrieved memory and expected gold fact, an LLM judge determines:
   - **entails**: Retrieved fact fully answers the question implied by the gold fact (counted as True Positive)
   - **contradicts**: Retrieved fact conflicts with the gold fact, often indicating stale information (counted toward Stale@K)
   - **unrelated**: Retrieved fact doesn't address the same question (ignored)

3. **Metrics Calculation**:
   - **Precision**: True Positives / Total Evaluations
   - **True Positive Rate**: Total TPs / Total Expected Gold Facts
   - **Stale@K**: Contradictions / Total Expected Gold Facts

## Generated on: 2025-08-15T05:58:37.543Z
