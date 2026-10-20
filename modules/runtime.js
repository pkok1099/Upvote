// modules/runtime.js — Semua state mutable yang dipakai lintas modul.
// Gunakan objek bersama (bukan re-ekspor `let`) agar perubahan terlihat di semua modul.
const rt = {
  // State hasil vote
  state: { sent: 0, failed: 0, started: 0, invalid: 0, entered: 0, lastValue: null, lastType: null, lastSuccessLabel: null },
  // Multi-target/tipe: pelacak delta per-counter {"chapter/<uuid>|reaction0": {chapter,type,max,entered,sent}}
  perTarget: {},
  // Daftar target ter-resolve (chapter/<uuid>)
  TARGETS: [],
  // Target tercapai (mode --count-real: entered >= maxVotes)
  targetReached: false,
  // Lane/worker aktif
  LANES: [],
  // Jumlah lane mati (counter global, hindari O(N) scan di hot loop worker)
  deadCount: 0,
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
  // Semaphore per-chapter: { "chapter/<uuid>": {active, queue:[resolve]} }
  chapterSlots: {},
  // Batas serentak per-chapter (mutable; auto-tune menggeser ini saat runtime)
  chapterLimit: 0,
  // Status auto-tune (ditampilkan dashboard/ringkasan)
  autoTuneInfo: null,
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
