const express = require('express');
const { assignmentService } = require('../services/assignmentService');

function createAssignmentRouter(service = assignmentService) {
  const router = express.Router();
  const handle = (action) => async (req, res) => {
    try {
      res.json(await action(req));
    } catch (error) {
      res.status(error.status || 500).json({
        success: false, error: error.message || 'Assignment request failed.', code: error.code,
        jobId: error.jobId, requestId: error.requestId, job: error.job,
      });
    }
  };
  router.post('/generate', handle((req) => service.generate(req.body)));
  router.post('/jobs/:jobId/status', handle((req) => service.status(req.params.jobId, req.body)));
  router.post('/jobs/:jobId/cancel', handle((req) => service.cancel(req.params.jobId, req.body)));
  return router;
}

module.exports = createAssignmentRouter();
module.exports.createAssignmentRouter = createAssignmentRouter;
