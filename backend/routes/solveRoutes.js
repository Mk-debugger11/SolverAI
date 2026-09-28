const express = require('express');
const router = express.Router();
const { solveMcq, getLlmConfig } = require('../services/llmService');

// Check LLM pipeline configuration status
router.get('/config', (req, res) => {
  try {
    const config = getLlmConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve LLM config', details: error.message });
  }
});

// Solve a multiple-choice or numerical question using the shared Groq pipeline.
router.post('/', async (req, res) => {
  const tBackendReceivedAt = Date.now();
  try {
    const {
      q,
      o,
      answerType,
      apiKey,
      model,
      turbo = true,
      maxTokens,
      max_tokens,
    } = req.body || {};

    const result = await solveMcq({
      q,
      o,
      answerType,
      apiKey,
      model,
      turbo,
      maxTokens: maxTokens ?? max_tokens,
      tBackendReceivedAt,
    });

    res.json(result);
  } catch (error) {
    console.error('Error in /api/solve:', error);
    const statusCode = error.status || 500;
    res.status(statusCode).json({
      error: error.message || 'LLM pipeline error',
      raw: error.raw,
      timings: error.timings,
    });
  }
});

module.exports = router;
