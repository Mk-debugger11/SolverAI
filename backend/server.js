require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connectDb } = require('./config/db');

// Route modules
const healthRoutes = require('./routes/healthRoutes');
const domRoutes = require('./routes/domRoutes');
const solveRoutes = require('./routes/solveRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');

const app = express();
const PORT = process.env.PORT || 5001;

// Middlewares
app.use(cors());
// Support large DOM payloads (webpages can have large HTML strings)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Mount Modular Routes
app.use('/api/health', healthRoutes);
app.use('/api/dom', domRoutes);
app.use('/api/solve', solveRoutes);
app.use('/api/assignments', assignmentRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// Initialize database and start HTTP server
async function startServer() {
  await connectDb();
  app.listen(PORT, () => {
    console.log(` Server running on http://localhost:${PORT}`);
  });
}

startServer();

module.exports = app;
