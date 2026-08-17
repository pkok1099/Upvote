/*
 * upctl.c — Pengganti proxy.sh + test-30.sh + test-p30.sh dalam C (native, libcurl).
 *
 * Perintah:
 *   upctl start   [dir] [--fast|--skip]   Nyalakan semua proxy (validasi IPv6 unik)
 *   upctl stop    [dir]                   Matikan semua proxy
 *   upctl restart [dir] [--fast|--skip]   Stop lalu start
 *   upctl status  [dir]                   Tampilkan status proxy + IPv6
 *   upctl list    [dir]                   Cetak daftar socks5:// untuk --proxy
 *   upctl test    [dir] [votes] [delay] [id]  Tes upvote-core.js (paralel)
 *
 * Default dir = "wgcf-multi" (start/stop/status/list/restart).
 * Build: clang -O2 upctl.c -lcurl -o upctl
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <dirent.h>
#include <ctype.h>
#include <errno.h>
#include <curl/curl.h>

#define MAXPATH 4096
#define NAMELEN 256

static char SCRIPT_DIR[MAXPATH] = ".";
static char CONF_DIR[MAXPATH]   = "";
static char PID_DIR[MAXPATH]    = "";
static char LOG_DIR[MAXPATH]    = "";
static char CORE_PATH[MAXPATH]  = "";
static const char *WIREPROXY    = "/data/data/com.termux/files/usr/bin/wireproxy";
static int FAST_MODE = 0;
static int SKIP_MODE = 0;

/* ---------- util ---------- */

static void die(const char *msg) {
    fprintf(stderr, "❌ %s\n", msg);
    exit(1);
}

static void path_join(char *dst, const char *base, const char *name) {
    snprintf(dst, MAXPATH, "%s/%s", base, name);
}

static const char *base_name(const char *path) {
    const char *p = strrchr(path, '/');
    return p ? p + 1 : path;
}

static int mkdir_p(const char *path) {
    char tmp[MAXPATH];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
    return mkdir(tmp, 0755);
}

static int is_alive(pid_t pid) {
    if (pid <= 0) return 0;
    return kill(pid, 0) == 0;
}

/* Baca seluruh file ke buf (max sz-1). Return bytes atau -1. */
static long read_file(const char *path, char *buf, size_t sz) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    long total = 0;
    while (total < (long)sz - 1) {
        long r = read(fd, buf + total, sz - 1 - total);
        if (r < 0) { if (errno == EINTR) continue; break; }
        if (r == 0) break;
        total += r;
    }
    buf[total] = '\0';
    close(fd);
    return total;
}

/* Ekstrak port dari BindAddress = host:port (case-insensitive). Return 0/1. */
static int get_port(const char *conf, int *port) {
    char buf[65536];
    if (read_file(conf, buf, sizeof(buf)) < 0) return 0;
    char *p = buf;
    while ((p = strcasestr(p, "BindAddress")) != NULL) {
        char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        /* cari ':' terakhir pada baris ini */
        char line[1024];
        if (len >= sizeof(line)) len = sizeof(line) - 1;
        memcpy(line, p, len);
        line[len] = '\0';
        char *colon = strrchr(line, ':');
        if (colon && isdigit((unsigned char)colon[1])) {
            *port = atoi(colon + 1);
            return 1;
        }
        p += 11;
    }
    return 0;
}

/* Cari PID wireproxy yg CMD-nya memuat basename conf. Return pid atau -1. */
static pid_t find_wireproxy_pid(const char *conf_abs) {
    const char *base = base_name(conf_abs);
    DIR *d = opendir("/proc");
    if (!d) return -1;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (!isdigit((unsigned char)e->d_name[0])) continue;
        char cp[MAXPATH];
        snprintf(cp, sizeof(cp), "/proc/%s/cmdline", e->d_name);
        char buf[4096];
        long n = read_file(cp, buf, sizeof(buf));
        if (n <= 0) continue;
        /* cmdline NUL-separated -> ubah NUL jadi spasi */
        for (long i = 0; i < n; i++) if (buf[i] == '\0') buf[i] = ' ';
        if (strstr(buf, "wireproxy") && strstr(buf, base)) {
            closedir(d);
            return (pid_t)atoi(e->d_name);
        }
    }
    closedir(d);
    return -1;
}

/* PID dari pidfile, atau cari via /proc lalu tulis pidfile. */
static pid_t get_running_pid(const char *conf_abs, const char *name) {
    char pf[MAXPATH];
    path_join(pf, PID_DIR, name);
    strcat(pf, ".pid");
    char buf[64];
    if (read_file(pf, buf, sizeof(buf)) > 0) {
        pid_t pid = (pid_t)atoi(buf);
        if (is_alive(pid)) return pid;
    }
    pid_t p = find_wireproxy_pid(conf_abs);
    if (p > 0) {
        FILE *f = fopen(pf, "w");
        if (f) { fprintf(f, "%d", (int)p); fclose(f); }
        return p;
    }
    return -1;
}

static void write_pidfile(const char *name, pid_t pid) {
    char pf[MAXPATH];
    path_join(pf, PID_DIR, name);
    strcat(pf, ".pid");
    FILE *f = fopen(pf, "w");
    if (f) { fprintf(f, "%d", (int)pid); fclose(f); }
}

/* ---------- curl (cek IPv6 via socks5h) ---------- */

struct membuf { char data[128]; size_t len; };

static size_t write_cb(void *ptr, size_t sz, size_t nmemb, void *userdata) {
    struct membuf *m = (struct membuf *)userdata;
    size_t total = sz * nmemb;
    if (m->len + total >= sizeof(m->data)) total = sizeof(m->data) - 1 - m->len;
    memcpy(m->data + m->len, ptr, total);
    m->len += total;
    m->data[m->len] = '\0';
    return sz * nmemb;
}

/* Sinkron: cek IPv6 proxy port via socks5h. Return strdup IP atau NULL (parent only). */
static char *check_ipv6_sync(int port) {
    CURL *c = curl_easy_init();
    if (!c) return NULL;
    char proxy[64];
    snprintf(proxy, sizeof(proxy), "socks5h://127.0.0.1:%d", port);
    struct membuf m; m.len = 0; m.data[0] = '\0';
    curl_easy_setopt(c, CURLOPT_URL, "https://api64.ipify.org");
    curl_easy_setopt(c, CURLOPT_PROXY, proxy);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, (long)(FAST_MODE ? 2 : 5));
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &m);
    CURLcode res = curl_easy_perform(c);
    char *out = NULL;
    if (res == CURLE_OK && m.len > 0) {
        while (m.len && isspace((unsigned char)m.data[m.len - 1])) m.data[--m.len] = '\0';
        if (m.len > 0) out = strdup(m.data);
    }
    curl_easy_cleanup(c);
    return out;
}

/* Fork child yg mengecek IPv6 proxy port, tulis hasil ke out_path. Return child pid. */
static pid_t fork_check_ipv6(int port, const char *out_path) {
    pid_t pid = fork();
    if (pid != 0) return pid; /* parent */
    /* child */
    FILE *out = fopen(out_path, "w");
    curl_global_init(CURL_GLOBAL_ALL);
    CURL *c = curl_easy_init();
    if (c) {
        char proxy[64];
        snprintf(proxy, sizeof(proxy), "socks5h://127.0.0.1:%d", port);
        struct membuf m; m.len = 0; m.data[0] = '\0';
        curl_easy_setopt(c, CURLOPT_URL, "https://api64.ipify.org");
        curl_easy_setopt(c, CURLOPT_PROXY, proxy);
        curl_easy_setopt(c, CURLOPT_TIMEOUT, (long)(FAST_MODE ? 2 : 5));
        curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_cb);
        curl_easy_setopt(c, CURLOPT_WRITEDATA, &m);
        CURLcode res = curl_easy_perform(c);
        if (res == CURLE_OK && m.len > 0 && out) {
            while (m.len && isspace((unsigned char)m.data[m.len - 1])) m.data[--m.len] = '\0';
            fwrite(m.data, 1, m.len, out);
        }
        curl_easy_cleanup(c);
    }
    curl_global_cleanup();
    if (out) fclose(out);
    _exit(0);
}

/* ---------- proxy lifecycle ---------- */

static pid_t start_one(const char *conf_abs, const char *name) {
    pid_t existing = get_running_pid(conf_abs, name);
    if (existing > 0) return existing;

    char logpath[MAXPATH];
    path_join(logpath, LOG_DIR, name);
    strcat(logpath, ".log");

    pid_t child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        setsid();
        int fd = open(logpath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); if (fd > 2) close(fd); }
        execl(WIREPROXY, "wireproxy", "-c", conf_abs, (char *)NULL);
        _exit(127);
    }
    usleep(300000);
    pid_t live = find_wireproxy_pid(conf_abs);
    pid_t pid = is_alive(child) ? child : live;
    if (pid > 0) write_pidfile(name, pid);
    return pid;
}

static void stop_one(const char *conf_abs, const char *name) {
    char pf[MAXPATH];
    path_join(pf, PID_DIR, name);
    strcat(pf, ".pid");
    pid_t pid = -1;
    char buf[64];
    if (read_file(pf, buf, sizeof(buf)) > 0) {
        pid = (pid_t)atoi(buf);
        if (!is_alive(pid)) pid = -1;
    }
    if (pid <= 0) pid = find_wireproxy_pid(conf_abs);
    if (pid > 0) kill(pid, SIGTERM);
    unlink(pf);
    printf("  🛑 %s dimatikan\n", name);
}

/* ---------- kumpulkan config ---------- */

static int collect_confs(char paths[][MAXPATH], char names[][NAMELEN], int max) {
    DIR *d = opendir(CONF_DIR);
    if (!d) return -1;
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && n < max) {
        size_t L = strlen(e->d_name);
        if (strncmp(e->d_name, "wgcf-", 5) == 0 && L > 5 && strcmp(e->d_name + L - 5, ".conf") == 0) {
            path_join(paths[n], CONF_DIR, e->d_name);
            snprintf(names[n], NAMELEN, "%.*s", (int)(L - 5), e->d_name); /* tanpa .conf */
            n++;
        }
    }
    closedir(d);
    return n;
}

/* ---------- validasi IPv6 (paralel via fork) ---------- */

static void validate_ips_parallel(char paths[][MAXPATH], char names[][NAMELEN], int n) {
    char tmpl[] = "/tmp/upctl.XXXXXX";
    char *ipdir = mkdtemp(tmpl);
    if (!ipdir) { fprintf(stderr, "⚠️  Gagal buat tmp dir\n"); return; }

    pid_t *pids = calloc(n, sizeof(pid_t));
    for (int i = 0; i < n; i++) {
        int port = 0;
        char ippath[MAXPATH];
        path_join(ippath, ipdir, names[i]);
        strcat(ippath, ".ip");
        if (get_port(paths[i], &port)) {
            pids[i] = fork_check_ipv6(port, ippath);
        } else {
            pids[i] = -1;
            FILE *f = fopen(ippath, "w"); if (f) fclose(f);
        }
    }

    int reaped = 0;
    while (reaped < n) {
        int st;
        pid_t p = waitpid(-1, &st, 0);
        if (p < 0) { if (errno == EINTR) continue; break; }
        reaped++;
    }

    char **used = calloc(n, sizeof(char *));
    char **dup_paths = calloc(n, sizeof(char *));
    char dup_names[NAMELEN * n];
    int used_n = 0, ok = 0, fail = 0, dup_n = 0;

    for (int i = 0; i < n; i++) {
        char ippath[MAXPATH];
        path_join(ippath, ipdir, names[i]);
        strcat(ippath, ".ip");
        char ip[128]; ip[0] = '\0';
        char buf[128];
        if (read_file(ippath, buf, sizeof(buf)) > 0) {
            size_t L = strlen(buf);
            while (L && isspace((unsigned char)buf[L - 1])) buf[--L] = '\0';
            if (L > 0) snprintf(ip, sizeof(ip), "%s", buf);
        }
        if (ip[0] == '\0') {
            printf("  ⚠️  %s: Gagal cek IP (proxy mungkin belum siap)\n", names[i]);
            fail++;
            continue;
        }
        int is_dup = 0;
        if (!FAST_MODE) {
            for (int j = 0; j < used_n; j++) {
                if (used[j] && strcmp(used[j], ip) == 0) { is_dup = 1; break; }
            }
        }
        if (is_dup) {
            printf("  ⚠️  %s: IP DUPLIKAT (%s) — perlu restart\n", names[i], ip);
            dup_paths[dup_n] = strdup(paths[i]);
            snprintf(dup_names + dup_n * NAMELEN, NAMELEN, "%s", names[i]);
            dup_n++;
            fail++;
        } else {
            used[used_n++] = strdup(ip);
            pid_t pid = get_running_pid(paths[i], names[i]);
            printf("  ✅ %s (PID %d | IPv6: %s)\n", names[i], (int)pid, ip);
            ok++;
        }
    }

    printf("\n  Hasil validasi: %d OK, %d bermasalah\n", ok, fail);

    if (dup_n > 0 && !FAST_MODE) {
        printf("  Merestart %d proxy dengan IP duplikat...\n", dup_n);
        for (int i = 0; i < dup_n; i++) {
            stop_one(dup_paths[i], dup_names + i * NAMELEN);
            usleep(500000);
            pid_t np = start_one(dup_paths[i], dup_names + i * NAMELEN);
            if (np > 0) printf("  🔄 %s distart ulang (PID %d)\n", dup_names + i * NAMELEN, (int)np);
        }
    }

    for (int i = 0; i < used_n; i++) free(used[i]);
    for (int i = 0; i < dup_n; i++) free(dup_paths[i]);
    free(used); free(dup_paths); free(pids);
    if (ipdir) remove(ipdir);
}

/* ---------- perintah ---------- */

static void cmd_start(void) {
    static char paths[2048][MAXPATH];
    static char names[2048][NAMELEN];
    int n = collect_confs(paths, names, 2048);
    if (n < 0) die("Folder config tidak ditemukan");
    if (n == 0) die("Tidak ada file config wgcf-*.conf di folder");

    mkdir_p(PID_DIR);
    mkdir_p(LOG_DIR);

    printf("Menyalakan proxy dari %s (Validasi IPv6 Unik)...\n\n", base_name(CONF_DIR));
    printf("[Fase 1] Start semua proxy...\n");
    for (int i = 0; i < n; i++) {
        int port = 0; get_port(paths[i], &port);
        pid_t preexist = get_running_pid(paths[i], names[i]);
        pid_t pid = start_one(paths[i], names[i]);
        if (pid > 0) {
            if (preexist > 0)
                printf("  ⏭️  %s SUDAH JALAN (PID %d | Port %d)\n", names[i], (int)pid, port);
            else
                printf("  🚀 %s DIJALANKAN (PID %d | Port %d)\n", names[i], (int)pid, port);
        } else {
            printf("  ❌ %s GAGAL START (Cek log: %s.log)\n", names[i], names[i]);
        }
    }

    if (SKIP_MODE) {
        printf("\nSelesai (skip mode, IP tidak divalidasi).\n");
        return;
    }

    int hw = FAST_MODE ? 1 : 3;
    printf("\n[Fase 2] Menunggu handshake WG (%ds)...\n", hw);
    sleep(hw);

    printf("\n[Fase 3] Validasi IPv6 paralel...\n");
    validate_ips_parallel(paths, names, n);
    printf("\nSelesai.\n");
}

static void cmd_stop(void) {
    static char paths[2048][MAXPATH];
    static char names[2048][NAMELEN];
    int n = collect_confs(paths, names, 2048);
    if (n < 0) die("Folder config tidak ditemukan");
    printf("Mematikan proxy dari %s...\n", base_name(CONF_DIR));
    for (int i = 0; i < n; i++) stop_one(paths[i], names[i]);
    printf("Selesai.\n");
}

static void cmd_status(void) {
    static char paths[2048][MAXPATH];
    static char names[2048][NAMELEN];
    int n = collect_confs(paths, names, 2048);
    if (n < 0) die("Folder config tidak ditemukan");
    printf("Status proxy (%s):\n", base_name(CONF_DIR));
    curl_global_init(CURL_GLOBAL_ALL);
    for (int i = 0; i < n; i++) {
        int port = 0; get_port(paths[i], &port);
        pid_t pid = get_running_pid(paths[i], names[i]);
        if (pid > 0) {
            char *ip = check_ipv6_sync(port);
            printf("  🟢 %s JALAN (PID %d | Port %d | IP: %s)\n",
                   names[i], (int)pid, port, ip ? ip : "'Gagal Cek IP'");
            free(ip);
        } else {
            printf("  🔴 %s MATI (Port %d)\n", names[i], port);
        }
    }
    curl_global_cleanup();
}

static void cmd_list(void) {
    static char paths[2048][MAXPATH];
    static char names[2048][NAMELEN];
    int n = collect_confs(paths, names, 2048);
    if (n < 0) die("Folder config tidak ditemukan");
    printf("Daftar proxy dari %s (untuk --proxy di upvote-core.js):\n", base_name(CONF_DIR));
    for (int i = 0; i < n; i++) {
        int port = 0; get_port(paths[i], &port);
        printf("  socks5://127.0.0.1:%d\n", port);
    }
}

static int log_has_marker(const char *logpath) {
    char buf[65536];
    if (read_file(logpath, buf, sizeof(buf)) < 0) return 0;
    return strstr(buf, "Received handshake response") != NULL;
}

static int run_node(const char *id, const char *votes, const char *delay,
                    const char *jitter, const char *api_url) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        execlp("node", "node", CORE_PATH,
               "--id", id,
               "--max", votes,
               "--delay", delay,
               "--jitter", jitter,
               "--parallel",
               "--api-url", api_url,
               "--proxy-dir", CONF_DIR,
               (char *)NULL);
        _exit(127);
    }
    int st;
    waitpid(pid, &st, 0);
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    return 1;
}

static void cmd_test(const char *votes, const char *delay, const char *id) {
    if (access(CORE_PATH, F_OK) != 0) die("upvote-core.js tidak ada");

    static char paths[2048][MAXPATH];
    static char names[2048][NAMELEN];
    int n = collect_confs(paths, names, 2048);
    if (n < 0) die("Folder config tidak ditemukan");
    if (n == 0) die("Tidak ada config proxy di folder");

    const char *api_url = getenv("API_URL");
    if (!api_url) api_url = "https://commento.shngm.io/api/article?lang=en";
    int d = atoi(delay);
    char jitter[32];
    snprintf(jitter, sizeof(jitter), "%d", d / 2);

    printf("==============================================\n");
    printf(" TES UPVOTE PROXY PARALEL\n");
    printf("==============================================\n");
    printf("Proxy ditemukan : %d\n", n);
    printf("Total vote      : %s\n", votes);
    printf("Delay           : %s ms (+jitter %s ms)\n", delay, jitter);
    printf("Target          : %s\n", id);
    printf("API             : %s\n", api_url);
    printf("==============================================\n");

    printf("\n[1/4] Menyalakan %d proxy...\n", n);
    SKIP_MODE = 1;
    for (int i = 0; i < n; i++) start_one(paths[i], names[i]);

    printf("\n[2/4] Menunggu tunnel WG handshake...\n");
    int MAX_WAIT = 20, waited = 0, ready = 0;
    while (waited < MAX_WAIT) {
        ready = 0;
        for (int i = 0; i < n; i++) {
            char lp[MAXPATH];
            path_join(lp, LOG_DIR, names[i]);
            strcat(lp, ".log");
            if (log_has_marker(lp)) ready++;
        }
        if (ready >= n) break;
        sleep(1);
        waited++;
    }
    printf("Proxy siap (handshake): %d/%d (tunggu %ds)\n", ready, n, waited);

    if (ready == 0) {
        printf("❌ Tidak ada proxy yang siap. Membatalkan tes.\n");
        return;
    }

    printf("\n[3/4] Menjalankan upvote-core.js (%s vote, paralel)...\n", votes);
    printf("----------------------------------------------\n");
    time_t t0 = time(NULL);
    int code = run_node(id, votes, delay, jitter, api_url);
    time_t t1 = time(NULL);
    int dur = (int)(t1 - t0);
    printf("----------------------------------------------\n");

    printf("\n[4/4] Mematikan %d proxy...\n", n);
    for (int i = 0; i < n; i++) stop_one(paths[i], names[i]);

    printf("\n==============================================\n");
    printf(" HASIL TES\n");
    printf("==============================================\n");
    printf("Exit code  : %d\n", code);
    printf("Durasi     : %d detik\n", dur);
    if (code == 0)
        printf("Status     : ✅ SUKSES — semua vote terkirim\n");
    else if (code == 130)
        printf("Status     : ⏹ DIHENTIKAN — progres tersimpan, bisa --resume\n");
    else
        printf("Status     : ❌ GAGAL — target tidak tercapai, cek log di atas\n");
    printf("==============================================\n");
}

/* ---------- setup & dispatch ---------- */

static void setup_dirs(const char *dir) {
    path_join(CONF_DIR, SCRIPT_DIR, dir && *dir ? dir : "wgcf-multi");
    path_join(PID_DIR, SCRIPT_DIR, ".proxy-pids");
    path_join(LOG_DIR, SCRIPT_DIR, ".proxy-logs");
    path_join(CORE_PATH, SCRIPT_DIR, "upvote-core.js");
}

static void usage(void) {
    printf(
        "upctl — Kelola proxy WireGuard/WGCF & jalankan tes upvote\n"
        "\n"
        "PENGGUNAAN\n"
        "  upctl <perintah> [folder-config] [opsi] [args...]\n"
        "\n"
        "PERINTAH\n"
        "  start   [dir] [--fast|--skip]  Nyalakan semua proxy di folder (1 proses wireproxy\n"
        "                                per file wgcf-*.conf). Ini HANYA menyalakan proxy,\n"
        "                                belum menjalankan vote.\n"
        "  stop    [dir]                  Matikan semua proxy (SIGTERM via PID file, fallback\n"
        "                                cari proses). HANYA mematikan proxy.\n"
        "  restart [dir]                  stop lalu start (jeda 1 detik) — proxy hidup lagi.\n"
        "  status  [dir]                  Cek tiap proxy: JALAN/MATI + nomor port, dan alamat\n"
        "                                IPv6 bila proxy menyala.\n"
        "  list    [dir]                  Cetak daftar proxy (socks5://127.0.0.1:port) untuk\n"
        "                                dipakai argumen --proxy-dir pada node.\n"
        "  test    [dir] [votes] [delay] [id]\n"
        "                                TES LENGKAP: start -> tunggu handshake WG siap ->\n"
        "                                jalankan upvote-core.js (paralel) -> stop. Satu perintah\n"
        "                                praktis untuk uji cepat, proxy otomatis dibersihkan.\n"
        "\n"
        "FOLDER CONFIG (default: wgcf-multi, yang TIDAK ada — selalu pakai folder nyata)\n"
        "  Isi: kumpulan file wgcf-*.conf. Tiap conf punya 'BindAddress = 127.0.0.1:<port>'.\n"
        "  Contoh tersedia: wgcf-30, wgcf-100, wgcf-p100.\n"
        "\n"
        "OPSI GLOBAL (boleh di mana saja, urutan bebas)\n"
        "  --skip   Start TANPA cek IPv6/unik -> paling cepat, tanpa jaminan IP berbeda.\n"
        "  --fast   Cek lebih ringan: lewati deteksi IP duplikat untuk proxy yg sudah jalan.\n"
        "           (--skip otomatis mengaktifkan --fast.)\n"
        "\n"
        "ARGS khusus perintah 'test' (default di belakang):\n"
        "  votes  = target jumlah vote sukses            (default 30)\n"
        "  delay  = jeda antar vote per proxy, dalam ms  (default 100)\n"
        "  id     = target UUID / chapter/<uuid>         (default bawaan tool)\n"
        "\n"
        "CONTOH\n"
        "  upctl status wgcf-30            Lihat status 30 proxy (MATI/JALAN + IPv6)\n"
        "  upctl start  wgcf-30 --skip     Nyalakan cepat tanpa cek IPv6\n"
        "  upctl stop   wgcf-30            Matikan semua proxy\n"
        "  upctl test   wgcf-30 30 100     Tes: 30 proxy, 30 vote, delay 100ms (lalu stop)\n"
        "  upctl test   wgcf-p100 100 200  Tes dengan folder 100 proxy\n"
        "\n"
        "Perbedaan inti:\n"
        "  'start/stop/status/list' hanya urus proxy (nyalakan/matikan/cek).\n"
        "  'test' sudah mencakup start + jalanin node + stop sekaligus.\n"
        "  Pakai 'start' bila mau proxy nyala terus (mis. untuk panggil node sendiri),\n"
        "  pakai 'test' bila mau sekalian jalanin + berhenti otomatis.\n"
    );
    exit(1);
}

int main(int argc, char **argv) {
    /* SCRIPT_DIR dari /proc/self/exe */
    char exepath[MAXPATH] = {0};
    ssize_t L = readlink("/proc/self/exe", exepath, sizeof(exepath) - 1);
    if (L > 0) {
        exepath[L] = '\0';
        char *slash = strrchr(exepath, '/');
        if (slash) { *slash = '\0'; snprintf(SCRIPT_DIR, MAXPATH, "%s", exepath); }
    } else {
        snprintf(SCRIPT_DIR, MAXPATH, ".");
    }

    if (argc < 2) usage();
    const char *cmd = argv[1];
    if (strcmp(cmd, "help") == 0 || strcmp(cmd, "-h") == 0 || strcmp(cmd, "--help") == 0) usage();

    /* parse flags + positional */
    const char *dir = NULL, *a1 = NULL, *a2 = NULL, *a3 = NULL;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--fast") == 0) FAST_MODE = 1;
        else if (strcmp(argv[i], "--skip") == 0) { SKIP_MODE = 1; FAST_MODE = 1; }
        else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) usage();
        else if (!dir) dir = argv[i];
        else if (!a1) a1 = argv[i];
        else if (!a2) a2 = argv[i];
        else if (!a3) a3 = argv[i];
    }

    if (strcmp(cmd, "test") == 0) {
        const char *tdir = dir ? dir : "wgcf-p100";
        const char *votes = a1 ? a1 : "30";
        const char *delay = a2 ? a2 : "100";
        const char *id = a3 ? a3 : "c88e67d1-6d18-46d0-8bb9-1b0491cd099e";
        setup_dirs(tdir);
        cmd_test(votes, delay, id);
        return 0;
    }

    setup_dirs(dir);

    if (strcmp(cmd, "start") == 0) cmd_start();
    else if (strcmp(cmd, "stop") == 0) cmd_stop();
    else if (strcmp(cmd, "restart") == 0) { cmd_stop(); sleep(1); cmd_start(); }
    else if (strcmp(cmd, "status") == 0) cmd_status();
    else if (strcmp(cmd, "list") == 0) cmd_list();
    else usage();

    return 0;
}
