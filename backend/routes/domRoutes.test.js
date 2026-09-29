const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const domRoutes = require('./domRoutes');

test('capture history fails promptly when MongoDB is disconnected', async () => {
  assert.notEqual(mongoose.connection.readyState, 1);
  const app = express();
  app.use('/api/dom', domRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/dom`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /MongoDB is disconnected/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
