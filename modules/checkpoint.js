// modules/checkpoint.js — Penyimpanan & pemuatan progres asinkron.
const fs = require("fs");
const config = require("./config");
const rt = require("./runtime");

function flushCheckpointSync() {
  const payload = JSON.stringify({ target: config.target, maxVotes: config.maxVotes, sent: rt.state.sent, failed: rt.state.failed, ts: Date.now() });
  try { fs.writeFileSync(config.checkpointFile, payload); } catch {}
}

function saveCheckpointAsync() {
  if (rt.isSavingCheckpoint) {
    rt.pendingCheckpointSave = true;
    return;
  }
  rt.isSavingCheckpoint = true;

  const payload = JSON.stringify({
    target: config.target,
    maxVotes: config.maxVotes,
    sent: rt.state.sent,
    failed: rt.state.failed,
    ts: Date.now(),
  });

  const tempFile = `${config.checkpointFile}.tmp`;
  fs.writeFile(tempFile, payload, (err) => {
    if (!err) {
      fs.rename(tempFile, config.checkpointFile, () => {
        rt.isSavingCheckpoint = false;
        if (rt.pendingCheckpointSave) {
          rt.pendingCheckpointSave = false;
          saveCheckpointAsync();
        }
      });
    } else {
      rt.isSavingCheckpoint = false;
    }
  });
}

function loadCheckpoint() {
  try {
    if (!fs.existsSync(config.checkpointFile)) return false;
    const cp = JSON.parse(fs.readFileSync(config.checkpointFile, "utf8"));
    if (cp.target === config.target) {
      rt.state.sent = cp.sent || 0;
      rt.state.failed = cp.failed || 0;
      rt.state.started = rt.state.sent + rt.state.failed;
      return true;
    }
  } catch {}
  return false;
}

module.exports = { flushCheckpointSync, saveCheckpointAsync, loadCheckpoint };
