// modules/runtime.js — Semua state mutable yang dipakai lintas modul.
// Gunakan objek bersama (bukan re-ekspor `let`) agar perubahan terlihat di semua modul.
const rt = {
  // State hasil vote
  state: { sent: 0, failed: 0, started: 0, invalid: 0, lastReaction0: null, lastSuccessLabel: null },
  // Lane/worker aktif
  LANES: [],
  // Flag shutdown anggun
  stopping: false,
  // Anggaran vote global (anti-overshoot)
  budget: 0,
  // Variabel dashboard
  currentRate: 0,        // vote/detik terkini, dipakai oleh frame dashboard
  dashboardPage: 0,      // halaman aktif saat tabel dipaginasi (terminal kecil)
  lastFrameHeight: 0,    // jumlah baris frame sebelumnya (repaint in-place TTY)
  lastFrameText: "",     // cache teks frame terakhir (non-TTY, cegah spam)
  // Semaphore global
  activeSlots: 0,
  slotQueue: [],
  // Checkpoint async
  isSavingCheckpoint: false,
  pendingCheckpointSave: false,
  // Render baris statistik
  prevRenderedLen: 0,
  prevRenderedWidth: 0,
  // Daftar proxy ter-resolve
  PROXIES: [],
};

module.exports = rt;
