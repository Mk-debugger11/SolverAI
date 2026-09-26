const mongoose = require('mongoose');

const DomRecordSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      default: 'Untitled',
      trim: true,
    },
    html: {
      type: String,
      required: true,
    },
    elementCount: {
      type: Number,
      default: 0,
    },
    sizeBytes: {
      type: Number,
      default: 0,
    },
    questions: [
      {
        questionId: String,
        groupName: String,
        question: String,
        questionAttributes: { type: mongoose.Schema.Types.Mixed, default: {} },
        containerAttributes: { type: mongoose.Schema.Types.Mixed, default: {} },
        options: [
          {
            id: String,
            text: String,
            value: String,
            checked: Boolean,
            attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
            labelAttributes: { type: mongoose.Schema.Types.Mixed, default: {} },
          },
        ],
        llmPayload: { type: mongoose.Schema.Types.Mixed, default: null },
        containerHtml: String,
      },
    ],
  },
  {
    timestamps: true, // adds createdAt and updatedAt
  }
);

module.exports = mongoose.model('DomRecord', DomRecordSchema);
