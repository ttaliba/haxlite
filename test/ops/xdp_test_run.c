// BPF_PROG_TEST_RUN harness for ops/haxguard/haxguard_xdp.c, driven by test/ops/haxguard.test.ts.
// Build: cc -O1 -Wall -o xdp_test_run xdp_test_run.c -lbpf     Run: ./xdp_test_run haxguard_xdp.o
// Needs CAP_BPF (root); exits 77 when the kernel refuses to load the program for lack of privileges.
// Prints one `name=value` line per measurement; the expectations live in the TS test.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <bpf/bpf.h>
#include <bpf/libbpf.h>

struct key4 { uint32_t saddr; uint16_t dport; uint16_t pad; };
struct entry { uint64_t expires_ns; };
struct bucket { uint64_t last_ns; uint32_t tokens; uint32_t over; };

enum { XDP_DROP_ = 1, XDP_PASS_ = 2 };
enum { G_STUN, G_PENDING };

static int prog_fd, active_fd, pending_fd, gbucket_fd;

static uint64_t mono(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec;
}

struct frame {
	const char *src;
	int sport, dport;
	int vlan, ihl_words, frag_off;
	int trunc_udp;                 // cut the frame 4 bytes into the UDP header
	const uint8_t *payload;
	int plen;
};

static int build(uint8_t *p, const struct frame *f) {
	int n = 12;
	memset(p, 0, 2048);
	memset(p, 0xaa, 6);
	memset(p + 6, 0xbb, 6);
	if (f->vlan) { p[n++] = 0x81; p[n++] = 0x00; p[n++] = 0; p[n++] = 5; }
	p[n++] = 0x08; p[n++] = 0x00;
	int ihl = f->ihl_words ? f->ihl_words : 5, ip = n, tot = ihl * 4 + 8 + f->plen;
	p[ip] = (uint8_t)(0x40 | ihl);
	p[ip + 2] = (uint8_t)(tot >> 8); p[ip + 3] = (uint8_t)tot;
	p[ip + 6] = (uint8_t)(f->frag_off >> 8); p[ip + 7] = (uint8_t)f->frag_off;
	p[ip + 8] = 64; p[ip + 9] = 17;
	inet_pton(AF_INET, f->src, p + ip + 12);
	inet_pton(AF_INET, "198.51.100.1", p + ip + 16);
	n += ihl * 4;
	p[n] = (uint8_t)(f->sport >> 8); p[n + 1] = (uint8_t)f->sport;
	p[n + 2] = (uint8_t)(f->dport >> 8); p[n + 3] = (uint8_t)f->dport;
	int l = 8 + f->plen;
	p[n + 4] = (uint8_t)(l >> 8); p[n + 5] = (uint8_t)l;
	memcpy(p + n + 8, f->payload, (size_t)f->plen);
	return f->trunc_udp ? n + 4 : n + 8 + f->plen;
}

static int run(const struct frame *f) {
	uint8_t pk[2048], out[2048];
	int n = build(pk, f);
	LIBBPF_OPTS(bpf_test_run_opts, o, .data_in = pk, .data_size_in = (uint32_t)n, .data_out = out,
	            .data_size_out = sizeof out, .repeat = 1);
	if (bpf_prog_test_run_opts(prog_fd, &o)) { perror("test_run"); exit(1); }
	return (int)o.retval;
}

static const uint8_t STUN[20] = { 0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };
static const uint8_t JUNK[40] = { 0xff };

static struct frame stun_from(const char *src) {
	struct frame f = { src, 40000, 20001, 0, 5, 0, 0, STUN, 20 };
	return f;
}
static struct frame junk_to(const char *src, int dport) {
	struct frame f = { src, 40000, dport, 0, 5, 0, 0, JUNK, 40 };
	return f;
}

static void set_gbucket(uint32_t idx, uint64_t last_ns, uint32_t tokens) {
	struct bucket b = { last_ns, tokens, 0 };
	if (bpf_map_update_elem(gbucket_fd, &idx, &b, BPF_ANY)) { perror("gbucket"); exit(1); }
}
static void allow_key(int fd, const char *src, uint64_t expires_ns) {
	struct key4 k = { 0, htons(20001), 0 };
	struct entry e = { expires_ns };
	inet_pton(AF_INET, src, &k.saddr);
	if (bpf_map_update_elem(fd, &k, &e, BPF_ANY)) { perror("allow_key"); exit(1); }
}
static void report(const char *name, int v) { printf("%s=%d\n", name, v); }

// Source `i` of a run: a.b.c.7 with b.c enumerating i; distinct public-looking addresses per `a`.
static void nth_ip(char *ip, size_t n, int a, int i) { snprintf(ip, n, "%d.%d.%d.7", a, i / 250, i % 250 + 1); }

static int count_pass(int a, int n, struct frame (*mk)(const char *)) {
	char ip[32];
	int pass = 0;
	for (int i = 0; i < n; i++) {
		nth_ip(ip, sizeof ip, a, i);
		struct frame f = mk(ip);
		if (run(&f) == XDP_PASS_) pass++;
	}
	return pass;
}
static struct frame junk_room(const char *src) { return junk_to(src, 20001); }

int main(int argc, char **argv) {
	if (argc < 2) { fprintf(stderr, "usage: %s haxguard_xdp.o\n", argv[0]); return 2; }
	struct bpf_object *obj = bpf_object__open_file(argv[1], NULL);
	if (!obj) { perror("open"); return 1; }
	struct bpf_map *m;
	bpf_object__for_each_map(m, obj) bpf_map__set_pin_path(m, NULL);       // no bpffs needed
	int err = bpf_object__load(obj);
	if (err == -EPERM || err == -ENOSYS) { fprintf(stderr, "bpf load refused: %d\n", err); return 77; }
	if (err) { fprintf(stderr, "load failed: %d\n", err); return 1; }
	prog_fd = bpf_program__fd(bpf_object__find_program_by_name(obj, "haxguard"));
	active_fd = bpf_object__find_map_fd_by_name(obj, "active4");
	pending_fd = bpf_object__find_map_fd_by_name(obj, "pending4");
	gbucket_fd = bpf_object__find_map_fd_by_name(obj, "gbucket");
	struct frame f;

	// Unknown sources: only STUN reaches the rooms, 10 packets of burst per source address.
	f = junk_to("203.0.113.9", 20001);
	report("unknown_non_stun", run(&f));
	int pass = 0;
	for (int i = 0; i < 30; i++) { f = stun_from("203.0.113.10"); if (run(&f) == XDP_PASS_) pass++; }
	report("stun_one_source_of_30", pass);

	// The kernel clock read by one CPU can precede a last_ns stored by another one: the bucket must not refill.
	set_gbucket(G_STUN, mono() + 30000000000ull, 0);
	report("stun_global_clock_behind_of_50", count_pass(45, 50, stun_from));
	set_gbucket(G_PENDING, mono() + 30000000000ull, 0);
	for (int i = 0; i < 50; i++) { char ip[32]; nth_ip(ip, sizeof ip, 46, i); allow_key(pending_fd, ip, mono() + 20000000000ull); }
	report("pending_global_clock_behind_of_50", count_pass(46, 50, junk_room));
	// An idle bucket (last_ns long ago) still refills, up to its burst and no further.
	set_gbucket(G_STUN, 1, 0);
	report("stun_global_idle_of_600", count_pass(47, 600, stun_from));

	// Players: known sources pass whatever they send, expired entries do not.
	allow_key(active_fd, "203.0.113.50", 0);
	f = junk_to("203.0.113.50", 20001);
	report("active_expired_non_stun", run(&f));
	allow_key(active_fd, "203.0.113.50", mono() + 300000000000ull);
	report("active_fresh_non_stun", run(&f));
	allow_key(pending_fd, "10.1.1.1", mono() + 20000000000ull);
	f = junk_to("10.1.1.1", 20001);
	report("pending_bogon_non_stun", run(&f));
	f = junk_to("203.0.113.9", 20001); f.vlan = 1;
	report("vlan_unknown_non_stun", run(&f));

	// Scope: only UDP to the room ports is judged; fragments and malformed packets go before the port check.
	f = junk_to("203.0.113.9", 5000);
	report("other_port_plain", run(&f));
	f.ihl_words = 6;
	report("other_port_ip_options", run(&f));
	f.ihl_words = 15;
	report("other_port_ip_options_max", run(&f));
	f.ihl_words = 4;
	report("other_port_ihl_below_5", run(&f));
	f = junk_to("203.0.113.9", 20001); f.ihl_words = 6;
	report("room_port_ip_options", run(&f));
	f = junk_to("203.0.113.9", 5000); f.frag_off = 0x2000;
	report("other_port_fragment", run(&f));
	f.frag_off = 0x00b9;
	report("other_port_fragment_tail", run(&f));
	f = junk_to("203.0.113.9", 20001); f.frag_off = 0x2000;
	report("room_port_fragment", run(&f));
	f = junk_to("203.0.113.9", 5000); f.trunc_udp = 1;
	report("other_port_truncated_udp", run(&f));
	return 0;
}
