// ---------------------------------------------------------------------------
// HTTP surface for the BrixOS Orchestrator (server/orchestrator.js).
//
// Kept in its own router — mounted from server/index.js — rather than
// growing that already-large file further, and so none of the EXISTING
// routes there (/api/generate, /api/chat, auth, profile, uploads) have to
// change at all for this to exist.
// ---------------------------------------------------------------------------

const express = require('express');
const rateLimit = require('express-rate-limit');
const orchestrator = require('./orchestrator');
const { readDB, getProfile } = require('./db');
const { createZip } = require('./zipBuilder');

function buildOrchestratorRouter({ requireAuth }) {
  const router = express.Router();

  // Generation is a multi-stage pipeline that can call external model APIs
  // several times per run — same rationale as the existing generateLimiter
  // in server/index.js, kept independent here since this is its own router.
  const generateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many generation requests this hour. Try again later.' }
  });

  const modifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many change requests. Slow down a little and try again.' }
  });

  // ---------------------------------------------------------------------
  // Claude paid-usage approval — a standalone read/set, independent of any
  // particular job, so the frontend can show/manage this as an account-level
  // setting ("BrixOS can use Claude for higher-quality planning — allow
  // it?") as well as reacting to a job that's actively paused on it.
  // ---------------------------------------------------------------------
  router.get('/claude-status', requireAuth, (req, res) => {
    res.json(orchestrator.getClaudeStatus(req.session.userId));
  });

  router.post('/claude-approval', requireAuth, (req, res) => {
    const approve = Boolean((req.body || {}).approve);
    res.json(orchestrator.setClaudeApproval(req.session.userId, approve));
  });

  // ---------------------------------------------------------------------
  // start a full generation run
  // ---------------------------------------------------------------------
  router.post('/generate', requireAuth, generateLimiter, (req, res) => {
    const job = orchestrator.startGeneration(req.session.userId);
    res.status(202).json(orchestrator.jobSummary(job));
  });

  // ---------------------------------------------------------------------
  // start a scoped modification ("make the hero more premium", ...)
  // ---------------------------------------------------------------------
  router.post('/modify', requireAuth, modifyLimiter, (req, res) => {
    const instruction = String((req.body || {}).instruction || '').trim();
    if (!instruction) return res.status(400).json({ error: 'Describe the change you want first.' });
    if (instruction.length > 1000) return res.status(400).json({ error: 'That request is a bit long — try trimming it.' });

    const db = readDB();
    const profile = getProfile(db, req.session.userId);
    if (!profile.generatedProject) return res.status(409).json({ error: 'Generate a site first before requesting changes.' });

    const job = orchestrator.startModification(req.session.userId, instruction);
    res.status(202).json(orchestrator.jobSummary(job));
  });

  // ---------------------------------------------------------------------
  // poll a job's status/log — this is what powers the
  // "Studying your business…" / "Generating homepage…" status line
  // ---------------------------------------------------------------------
  router.get('/jobs/:jobId', requireAuth, (req, res) => {
    const job = orchestrator.getJob(req.params.jobId);
    if (!job || job.userId !== req.session.userId) return res.status(404).json({ error: 'Job not found.' });
    res.json(orchestrator.jobSummary(job));
  });

  // ---------------------------------------------------------------------
  // answer the "Claude API usage may incur charges — continue?" prompt for
  // a job that's paused in AWAITING_APPROVAL
  // ---------------------------------------------------------------------
  router.post('/jobs/:jobId/approve', requireAuth, (req, res) => {
    const job = orchestrator.getJob(req.params.jobId);
    if (!job || job.userId !== req.session.userId) return res.status(404).json({ error: 'Job not found.' });
    const approve = Boolean((req.body || {}).approve);
    const resumed = orchestrator.resumeAfterApproval(req.params.jobId, approve);
    res.json(orchestrator.jobSummary(resumed));
  });

  // ---------------------------------------------------------------------
  // ZIP export — the fallback/output option when the user wants the actual
  // files, not just the in-app preview.
  // ---------------------------------------------------------------------
  router.get('/export', requireAuth, (req, res) => {
    const db = readDB();
    const profile = getProfile(db, req.session.userId);
    const project = profile.generatedProject;
    if (!project || !project.pages || !Object.keys(project.pages).length) {
      return res.status(404).json({ error: 'Nothing to export yet — generate a site first.' });
    }

    try {
      const files = Object.keys(project.pages).map((slug) => ({
        name: (slug === 'index' ? 'index' : slug) + '.html',
        content: project.pages[slug]
      }));
      const zipBuf = createZip(files);
      const safeName = String(profile.business || 'brixos-site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brixos-site';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
      res.send(zipBuf);
    } catch (err) {
      console.error('[BrixOS Orchestrator] export failed:', err);
      res.status(500).json({ error: 'Could not build the export ZIP — try again in a moment.' });
    }
  });

  return router;
}

module.exports = { buildOrchestratorRouter };
