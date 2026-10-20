// modules/checkpoint.js — Penyimpanan & pemuatan progres asinkron.
const fs = require("fs");
const config = require("./cli");
const rt = require("./runtime");
const { extractChapterId } = require("./util");

function flushCheckpointSync() {
  const payload = JSON.stringify({ targets: rt.TARGETS, target: config.target, maxVotes: config.maxVotes, sent: rt.state.sent, failed: rt.state.failed, entered: rt.state.entered, perTarget: rt.perTarget, ts: Date.now() });
  const tempFile = `${config.checkpointFile}.tmp`;
  try {
    fs.writeFileSync(tempFile, payload);
    fs.renameSync(tempFile, config.checkpointFile);
  } catch {}
}

function saveCheckpointAsync() {
  if (rt.isSavingCheckpoint) {
    rt.pendingCheckpointSave = true;
    return;
  }
  rt.isSavingCheckpoint = true;

  const payload = JSON.stringify({
    targets: rt.TARGETS,
    target: config.target,
    maxVotes: config.maxVotes,
    sent: rt.state.sent,
    failed: rt.state.failed,
    entered: rt.state.entered,
    perTarget: rt.perTarget,
    ts: Date.now(),
  });

  const tempFile = `${config.checkpointFile}.tmp`;
  fs.writeFile(tempFile, payload, (err) => {
    if (err) {
      rt.isSavingCheckpoint = false;
      return;
    }
    if (rt.stopping) {
      rt.isSavingCheckpoint = false;
      fs.unlink(tempFile, () => {});
      return;
    }
    fs.rename(tempFile, config.checkpointFile, () => {
      rt.isSavingCheckpoint = false;
      if (rt.pendingCheckpointSave && !rt.stopping) {
        rt.pendingCheckpointSave = false;
        setTimeout(saveCheckpointAsync, 150);
      }
    });
  });
}

function loadCheckpoint() {
  try {
    if (!fs.existsSync(config.checkpointFile)) return false;
    const cp = JSON.parse(fs.readFileSync(config.checkpointFile, "utf8"));
    const rawCpTargets = Array.isArray(cp.targets) && cp.targets.length ? cp.targets : (cp.target ? [cp.target] : []);
    const cpTargets = rawCpTargets.map(extractChapterId).filter(Boolean);
    const rawCurrent = (rt.TARGETS && rt.TARGETS.length) ? rt.TARGETS : (config.targets && config.targets.length ? config.targets : [config.target]);
    const currentTargets = rawCurrent.map(extractChapterId).filter(Boolean);

    const match = cpTargets.length > 0 && cpTargets.length === currentTargets.length &&
      cpTargets.slice().sort().every((v, i) => v === currentTargets.slice().sort()[i]);

    if (match) {
      rt.state.sent = cp.sent || 0;
      rt.state.failed = cp.failed || 0;
      rt.state.entered = cp.entered || 0;
      if (cp.perTarget && typeof cp.perTarget === "object") rt.perTarget = cp.perTarget;
      rt.state.started = rt.state.sent + rt.state.failed;
      return true;
    }
  } catch {}
  return false;
}

module.exports = { flushCheckpointSync, saveCheckpointAsync, loadCheckpoint };
