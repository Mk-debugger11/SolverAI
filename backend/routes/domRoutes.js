const express = require('express');
const router = express.Router();
const DomRecord = require('../models/DomRecord');

// Save a new DOM capture
router.post('/', async (req, res) => {
  try {
    const { url, title, html, elementCount, sizeBytes, questions } = req.body;

    if (!url || !html) {
      return res.status(400).json({ error: 'URL and HTML content are required' });
    }

    const record = await DomRecord.create({
      url,
      title: title || 'Untitled',
      html,
      elementCount: elementCount || 0,
      sizeBytes: sizeBytes || Buffer.byteLength(html, 'utf8'),
      questions: Array.isArray(questions) ? questions : [],
    });

    res.status(201).json({
      message: 'DOM captured and saved successfully',
      record: {
        _id: record._id,
        url: record.url,
        title: record.title,
        elementCount: record.elementCount,
        sizeBytes: record.sizeBytes,
        questionsCount: record.questions.length,
        createdAt: record.createdAt,
      },
    });
  } catch (error) {
    console.error('Error saving DOM record:', error);
    res.status(500).json({ error: 'Failed to save DOM record', details: error.message });
  }
});

// Get all saved DOM records (excluding full HTML for speed)
router.get('/', async (req, res) => {
  try {
    const records = await DomRecord.find()
      .select('-html')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(records);
  } catch (error) {
    console.error('Error fetching DOM records:', error);
    res.status(500).json({ error: 'Failed to fetch DOM records', details: error.message });
  }
});

// Get a single DOM record with full HTML
router.get('/:id', async (req, res) => {
  try {
    const record = await DomRecord.findById(req.params.id);
    if (!record) {
      return res.status(400).json({ error: 'Record not found' });
    }
    res.json(record);
  } catch (error) {
    console.error('Error fetching DOM record:', error);
    res.status(500).json({ error: 'Failed to fetch DOM record', details: error.message });
  }
});

// Delete a saved DOM record
router.delete('/:id', async (req, res) => {
  try {
    const record = await DomRecord.findByIdAndDelete(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }
    res.json({ message: 'Record deleted successfully', id: req.params.id });
  } catch (error) {
    console.error('Error deleting DOM record:', error);
    res.status(500).json({ error: 'Failed to delete record', details: error.message });
  }
});

module.exports = router;
