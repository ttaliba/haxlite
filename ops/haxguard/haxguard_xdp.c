// haxguard_xdp.c: boceto XDP (IPv4) equivalente a haxguard.nft. IPv6 análogo con claves de 16 B.
// Compilar: clang -O2 -g -target bpf -c haxguard_xdp.c -o haxguard_xdp.o
// Cargar:   ip link set dev eth0 xdpgeneric obj haxguard_xdp.o sec xdp   (xdpdrv si el driver lo soporta)
//           o xdp-loader load -m native eth0 haxguard_xdp.o ; mapas fijados en /sys/fs/bpf/haxguard/
// Actualizar desde el sidecar: bpftool map update pinned /sys/fs/bpf/haxguard/active4 key hex <ip4 BE> <port BE> 00 00 value hex 01 00 00 00 ...
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <linux/in.h>

#define SEC(n) __attribute__((section(n), used))
#define __uint(name, val) int (*name)[val]
#define __type(name, val) typeof(val) *name
static void *(*bpf_map_lookup_elem)(void *map, const void *key) = (void *)BPF_FUNC_map_lookup_elem;
static __u64 (*bpf_ktime_get_ns)(void) = (void *)BPF_FUNC_ktime_get_ns;

#define ROOM_PORT_MIN 20000
#define ROOM_PORT_MAX 20999
#define STUN_COOKIE 0x2112A442
#define STUN_PPS_PER_SRC 5
#define STUN_BURST 10

struct key4 { __u32 saddr; __u16 dport; __u16 pad; };          // (IP origen . puerto sala), orden de red
struct entry { __u64 expires_ns; };                             // 0 = sin caducidad (active)
struct bucket { __u64 last_ns; __u32 tokens; __u32 pad; };

struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 65536); __type(key, struct key4); __type(value, struct entry); __uint(pinning, 1); } active4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 65536); __type(key, struct key4); __type(value, struct entry); __uint(pinning, 1); } pending4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_LPM_TRIE); __uint(max_entries, 65536); __type(key, __u64); __type(value, __u32); __uint(map_flags, BPF_F_NO_PREALLOC); __uint(pinning, 1); } deny4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_LRU_HASH); __uint(max_entries, 131072); __type(key, __u32); __type(value, struct bucket); } stunrate4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY); __uint(max_entries, 8); __type(key, __u32); __type(value, __u64); __uint(pinning, 1); } stats SEC(".maps");

enum { S_FRAG, S_LOWPORT, S_DENY, S_ACTIVE, S_PENDING, S_STUN_OK, S_STUN_OVER, S_DROP };
static __always_inline int count(__u32 i, int verdict) {
	__u64 *c = bpf_map_lookup_elem(&stats, &i);
	if (c) *c += 1;
	return verdict;
}
static __always_inline int fresh(struct entry *e, __u64 now) { return e && (e->expires_ns == 0 || e->expires_ns > now); }

SEC("xdp")
int haxguard(struct xdp_md *ctx) {
	void *data = (void *)(long)ctx->data, *end = (void *)(long)ctx->data_end;
	struct ethhdr *eth = data;
	if ((void *)(eth + 1) > end || eth->h_proto != __constant_htons(ETH_P_IP)) return XDP_PASS; // (VLAN/IPv6: ampliar)
	struct iphdr *ip = (void *)(eth + 1);
	if ((void *)(ip + 1) > end || ip->protocol != IPPROTO_UDP) return XDP_PASS;
	if (ip->frag_off & __constant_htons(0x3fff)) return count(S_FRAG, XDP_DROP);   // sin fragmentos UDP
	if (ip->ihl != 5) return XDP_DROP;                                               // opciones IP: nunca en WebRTC
	struct udphdr *udp = (void *)(ip + 1);
	if ((void *)(udp + 1) > end) return XDP_DROP;
	__u16 dport = __builtin_bswap16(udp->dest), sport = __builtin_bswap16(udp->source);
	if (dport < ROOM_PORT_MIN || dport > ROOM_PORT_MAX) return XDP_PASS;
	struct { __u32 prefixlen; __u32 addr; } lpm = { 32, ip->saddr };
	if (bpf_map_lookup_elem(&deny4, &lpm)) return count(S_DENY, XDP_DROP);
	if (sport < 1024) return count(S_LOWPORT, XDP_DROP);                             // DNS/NTP/CLDAP/SSDP... reflexión
	__u64 now = bpf_ktime_get_ns();                                                  // CLOCK_MONOTONIC (= process.hrtime en Linux)
	struct key4 k = { ip->saddr, udp->dest, 0 };
	if (fresh(bpf_map_lookup_elem(&active4, &k), now)) return count(S_ACTIVE, XDP_PASS);
	if (fresh(bpf_map_lookup_elem(&pending4, &k), now)) return count(S_PENDING, XDP_PASS);
	// Desconocido: solo STUN (2 bits altos 00 + magic cookie), con token bucket por origen.
	__u8 *stun = (void *)(udp + 1);
	if ((void *)(stun + 20) > end || (stun[0] & 0xc0) != 0 || *(__u32 *)(stun + 4) != __constant_htonl(STUN_COOKIE))
		return count(S_DROP, XDP_DROP);
	struct bucket *b = bpf_map_lookup_elem(&stunrate4, &ip->saddr);
	if (!b) {
		struct bucket nb = { now, STUN_BURST - 1, 0 };
		long (*update)(void *, const void *, const void *, __u64) = (void *)BPF_FUNC_map_update_elem;
		update(&stunrate4, &ip->saddr, &nb, BPF_ANY);
		return count(S_STUN_OK, XDP_PASS);
	}
	__u64 refill = (now - b->last_ns) * STUN_PPS_PER_SRC / 1000000000ull;
	if (refill) { b->tokens = b->tokens + refill > STUN_BURST ? STUN_BURST : b->tokens + refill; b->last_ns = now; }
	if (b->tokens == 0) return count(S_STUN_OVER, XDP_DROP);
	b->tokens--;   // (carrera benigna entre CPUs; aceptable para un limitador)
	return count(S_STUN_OK, XDP_PASS);
	// Mejora opcional: además exigir que el atributo USERNAME (0x0006) empiece por un ufrag local
	// vigente (mapa ufrags4, clave = 4..8 primeros bytes) => solo quien recibió la answer por la
	// señalización del master puede llegar a libjuice. Límite global: contador per-CPU por ventana.
}

char LICENSE[] SEC("license") = "GPL";
