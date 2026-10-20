// haxguard_xdp.c: boceto XDP (IPv4) con los mismos pasos que haxguard.nft salvo lo listado abajo.
// Compilar: clang -O2 -g -target bpf -I/usr/include/$(uname -m)-linux-gnu -c haxguard_xdp.c -o haxguard_xdp.o
//           (Debian/Ubuntu: el -I da asm/types.h, paquete linux-libc-dev; -DHG_DROP_V6 para descartar IPv6 a ROOM_PORT)
// Cargar:   ip link set dev eth0 xdpgeneric obj haxguard_xdp.o sec xdp   (xdpdrv si el driver lo soporta)
//           o xdp-loader load -m native eth0 haxguard_xdp.o ; mapas fijados en /sys/fs/bpf/haxguard/
// Actualizar desde el sidecar (mismo contrato que haxguard.nft: pending 20 s sin refrescar, active refrescado
// cada 60 s con caducidad de 5 min, borrar al salir):
//   bpftool map update pinned /sys/fs/bpf/haxguard/active4 key hex <ip4 BE> <port BE> 00 00 value hex <expires_ns LE, 8 B>
//   con expires_ns = CLOCK_MONOTONIC (ns) + 300e9. expires_ns = 0 significa caducado (nunca hay entradas eternas). Los HASH de BPF
//   no borran las entradas caducadas, solo las ignoran: el sidecar debe borrarlas o el mapa se llena (-E2BIG).
//
// Alcance y diferencias con haxguard.nft:
//  - IPv4 sobre Ethernet, con hasta 2 etiquetas 802.1Q/802.1ad. NO hay active6/pending6/deny6: el UDP IPv6 a ROOM_PORT no
//    se filtra; se cuenta en S_V6 y pasa (XDP_DROP con -DHG_DROP_V6, que corta también a los jugadores IPv6). Las cabeceras de
//    extensión IPv6 no se recorren. Usar con rtc.ipv6:false o combinar con haxguard.nft, que sí filtra IPv6.
//  - Solo se filtra el UDP a ROOM_PORT; el resto pasa. Excepciones, que se descartan antes de mirar el puerto igual que en
//    haxguard.nft: los fragmentos UDP IPv4 de cualquier puerto (un fragmento no inicial no lleva cabecera UDP; WebRTC no
//    fragmenta, pero DNS/EDNS, IKE o syslog grandes al mismo host dejarían de llegar), la cabecera IPv4 de menos de 20 B y
//    el UDP truncado (paquetes malformados que el kernel descartaría igual). Las opciones IP (ihl > 5) solo se
//    descartan hacia ROOM_PORT; hacia otros puertos el paquete pasa.
//  - Sin amp_sports ni stun_servers4 (las respuestas de un STUN propio entran por el carril de STUN de desconocidos).
//  - El carril de STUN de desconocidos limita por IP origen, igual que haxguard.nft con sus máscaras por defecto, y no hay
//    set "lleno" que falle en abierto: stunrate4 es LRU.
//  - Los topes son cubos de fichas con una carrera benigna entre CPUs (cada cola de un driver nativo puede gastar la misma
//    ficha o recargar el mismo intervalo): el tope real puede salir más laxo que en nft, hasta como mucho el número de
//    colas que corren a la vez. Un reloj que va hacia atrás entre CPUs (now < last_ns) cuenta como 0 s transcurridos y no
//    recarga el cubo. `over` de cada cubo cuenta los descartes por IP para el sidecar.
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/udp.h>
#include <linux/in.h>

#define SEC(n) __attribute__((section(n), used))
#define __uint(name, val) int (*name)[val]
#define __type(name, val) typeof(val) *name
static void *(*bpf_map_lookup_elem)(void *map, const void *key) = (void *)BPF_FUNC_map_lookup_elem;
static long (*bpf_map_update_elem)(void *map, const void *key, const void *value, __u64 flags) = (void *)BPF_FUNC_map_update_elem;
static __u64 (*bpf_ktime_get_ns)(void) = (void *)BPF_FUNC_ktime_get_ns;

#define ROOM_PORT_MIN 20000
#define ROOM_PORT_MAX 20999
#define STUN_COOKIE 0x2112A442
#define STUN_PPS_PER_SRC 5
#define STUN_BURST 10
#define STUN_GLOBAL_PPS 2000
#define STUN_GLOBAL_BURST 500
#define ACTIVE_PPS 1000                 // por jugador unido
#define ACTIVE_BURST 200
#define PENDING_PPS 500                 // por IP del carril pending
#define PENDING_BURST 300
#define PENDING_GLOBAL_PPS 10000
#define PENDING_GLOBAL_BURST 2000
#ifdef HG_DROP_V6
#define HG_V6_VERDICT XDP_DROP
#else
#define HG_V6_VERDICT XDP_PASS
#endif

struct key4 { __u32 saddr; __u16 dport; __u16 pad; };          // (IP origen . puerto sala), orden de red
struct entry { __u64 expires_ns; };                             // CLOCK_MONOTONIC; 0 o pasado = caducado
struct bucket { __u64 last_ns; __u32 tokens; __u32 over; };     // over: descartes de este cubo
struct lpm4 { __u32 prefixlen; __u32 addr; };                   // clave de deny4 (LPM): prefixlen primero, IP en orden de red
struct vlanhdr { __be16 tci; __be16 proto; };

struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 65536); __type(key, struct key4); __type(value, struct entry); __uint(pinning, 1); } active4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 65536); __type(key, struct key4); __type(value, struct entry); __uint(pinning, 1); } pending4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_LPM_TRIE); __uint(max_entries, 65536); __type(key, struct lpm4); __type(value, __u32); __uint(map_flags, BPF_F_NO_PREALLOC); __uint(pinning, 1); } deny4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_LRU_HASH); __uint(max_entries, 131072); __type(key, __u32); __type(value, struct bucket); } stunrate4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_LRU_HASH); __uint(max_entries, 131072); __type(key, __u32); __type(value, struct bucket); __uint(pinning, 1); } actrate4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_LRU_HASH); __uint(max_entries, 131072); __type(key, __u32); __type(value, struct bucket); } pendrate4 SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_ARRAY); __uint(max_entries, 2); __type(key, __u32); __type(value, struct bucket); } gbucket SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY); __uint(max_entries, 16); __type(key, __u32); __type(value, __u64); __uint(pinning, 1); } stats SEC(".maps");

// Los 8 primeros índices no cambian. S_V6: UDP IPv6 a ROOM_PORT sin filtrar (o descartado con HG_DROP_V6).
enum { S_FRAG, S_LOWPORT, S_DENY, S_ACTIVE, S_PENDING, S_STUN_OK, S_STUN_OVER, S_DROP,
       S_ACTIVE_OVER, S_PENDING_OVER, S_STUN_OVER_GLOBAL, S_V6 };
enum { G_STUN, G_PENDING };                                     // índices de gbucket
static __always_inline int count(__u32 i, int verdict) {
	__u64 *c = bpf_map_lookup_elem(&stats, &i);
	if (c) *c += 1;
	return verdict;
}
static __always_inline int fresh(struct entry *e, __u64 now) { return e && e->expires_ns > now; }

// Origen no enrutable en Internet (0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4 y 240/4).
static __always_inline int bogon4(__u32 a) {
	__u32 h = __builtin_bswap32(a);
	return (h >> 24) == 0 || (h >> 24) == 10 || (h >> 24) == 127 || h >= 0xe0000000 ||
	       (h >> 16) == 0xa9fe || (h & 0xfff00000) == 0xac100000 || (h >> 16) == 0xc0a8;
}

// Cubo de fichas: pps de recarga y ráfaga. Devuelve 0 (y cuenta en b->over) si no queda ficha.
static __always_inline int allow(struct bucket *b, __u64 now, __u32 pps, __u32 burst) {
	// Otra CPU puede haber guardado un last_ns posterior a este now (se lee antes de que ella escriba): sin la
	// guarda la resta da la vuelta, parece que pasó mucho tiempo y el cubo se llena entero. last_ns solo avanza
	// (refill > 0 implica now > last_ns).
	__u64 d = now > b->last_ns ? now - b->last_ns : 0;
	if (d > 10000000000ull) d = 10000000000ull;                 // evita desbordar y basta para llenar el cubo
	__u64 refill = d * pps / 1000000000ull;
	if (refill) { __u64 t = b->tokens + refill; b->tokens = t > burst ? burst : t; b->last_ns = now; }
	if (b->tokens == 0) { b->over++; return 0; }
	b->tokens--;   // (carrera benigna entre CPUs; no atómico a propósito: un xadd podría dar la vuelta bajo 0)
	return 1;
}
static __always_inline void new_bucket(void *map, __u32 saddr, __u64 now, __u32 burst) {
	struct bucket nb = { now, burst - 1, 0 };
	bpf_map_update_elem(map, &saddr, &nb, BPF_ANY);
}
// Tope por IP origen sobre un LRU; el primer paquete de una IP crea el cubo.
static __always_inline int allow_src(void *map, __u32 saddr, __u64 now, __u32 pps, __u32 burst) {
	struct bucket *b = bpf_map_lookup_elem(map, &saddr);
	if (b) return allow(b, now, pps, burst);
	new_bucket(map, saddr, now, burst);
	return 1;
}
static __always_inline int allow_global(__u32 i, __u64 now, __u32 pps, __u32 burst) {
	struct bucket *g = bpf_map_lookup_elem(&gbucket, &i);
	return g && allow(g, now, pps, burst);
}

SEC("xdp")
int haxguard(struct xdp_md *ctx) {
	void *data = (void *)(long)ctx->data, *end = (void *)(long)ctx->data_end;
	struct ethhdr *eth = data;
	if ((void *)(eth + 1) > end) return XDP_PASS;
	__u16 proto = eth->h_proto;
	void *l3 = eth + 1;
#pragma unroll
	for (int i = 0; i < 2; i++) {                                                    // hasta 2 etiquetas 802.1Q / 802.1ad
		if (proto != __constant_htons(ETH_P_8021Q) && proto != __constant_htons(ETH_P_8021AD)) break;
		struct vlanhdr *v = l3;
		if ((void *)(v + 1) > end) return XDP_PASS;
		proto = v->proto;
		l3 = v + 1;
	}
	if (proto == __constant_htons(ETH_P_IPV6)) {                                     // sin filtro IPv6: solo contar (ver cabecera)
		struct ipv6hdr *ip6 = l3;
		if ((void *)(ip6 + 1) > end || ip6->nexthdr != IPPROTO_UDP) return XDP_PASS;
		struct udphdr *u6 = (void *)(ip6 + 1);
		if ((void *)(u6 + 1) > end) return XDP_PASS;
		__u16 d6 = __builtin_bswap16(u6->dest);
		if (d6 < ROOM_PORT_MIN || d6 > ROOM_PORT_MAX) return XDP_PASS;
		return count(S_V6, HG_V6_VERDICT);
	}
	if (proto != __constant_htons(ETH_P_IP)) return XDP_PASS;
	struct iphdr *ip = l3;
	if ((void *)(ip + 1) > end || ip->protocol != IPPROTO_UDP) return XDP_PASS;
	if (ip->frag_off & __constant_htons(0x3fff)) return count(S_FRAG, XDP_DROP);   // sin fragmentos UDP, de cualquier puerto
	__u32 ihl = ip->ihl * 4;
	if (ihl < sizeof(*ip)) return XDP_DROP;                                          // cabecera IPv4 inválida
	struct udphdr *udp = (void *)ip + ihl;
	if ((void *)(udp + 1) > end) return XDP_DROP;                                    // UDP truncado
	__u16 dport = __builtin_bswap16(udp->dest), sport = __builtin_bswap16(udp->source);
	if (dport < ROOM_PORT_MIN || dport > ROOM_PORT_MAX) return XDP_PASS;
	if (ihl != sizeof(*ip)) return XDP_DROP;                                         // opciones IP: nunca en WebRTC
	struct lpm4 lpm = { 32, ip->saddr };
	if (bpf_map_lookup_elem(&deny4, &lpm)) return count(S_DENY, XDP_DROP);
	if (sport < 1024) return count(S_LOWPORT, XDP_DROP);                             // DNS/NTP/CLDAP/SSDP... reflexión
	__u64 now = bpf_ktime_get_ns();                                                  // CLOCK_MONOTONIC (= process.hrtime en Linux)
	struct key4 k = { ip->saddr, udp->dest, 0 };
	if (fresh(bpf_map_lookup_elem(&active4, &k), now)) {
		if (!allow_src(&actrate4, ip->saddr, now, ACTIVE_PPS, ACTIVE_BURST)) return count(S_ACTIVE_OVER, XDP_DROP);
		return count(S_ACTIVE, XDP_PASS);
	}
	if (fresh(bpf_map_lookup_elem(&pending4, &k), now) && !bogon4(ip->saddr)) {
		if (!allow_src(&pendrate4, ip->saddr, now, PENDING_PPS, PENDING_BURST) ||
		    !allow_global(G_PENDING, now, PENDING_GLOBAL_PPS, PENDING_GLOBAL_BURST))
			return count(S_PENDING_OVER, XDP_DROP);
		return count(S_PENDING, XDP_PASS);
	}
	// Desconocido: solo STUN (2 bits altos 00 + magic cookie), con token bucket por origen y otro global.
	__u8 *stun = (void *)(udp + 1);
	if ((void *)(stun + 20) > end || (stun[0] & 0xc0) != 0 || *(__u32 *)(stun + 4) != __constant_htonl(STUN_COOKIE))
		return count(S_DROP, XDP_DROP);
	// Por origen primero: una IP que inunda se corta con su propio cubo sin gastar el global. Un origen
	// nuevo solo crea cubo si el global lo deja pasar, para que un flood suplantado no desaloje (LRU) a los reales.
	struct bucket *b = bpf_map_lookup_elem(&stunrate4, &ip->saddr);
	if (b && !allow(b, now, STUN_PPS_PER_SRC, STUN_BURST)) return count(S_STUN_OVER, XDP_DROP);
	if (!allow_global(G_STUN, now, STUN_GLOBAL_PPS, STUN_GLOBAL_BURST)) return count(S_STUN_OVER_GLOBAL, XDP_DROP);
	if (!b) new_bucket(&stunrate4, ip->saddr, now, STUN_BURST);
	return count(S_STUN_OK, XDP_PASS);
	// Mejora opcional: además exigir que el atributo USERNAME (0x0006) empiece por un ufrag local
	// vigente (mapa ufrags4, clave = 4..8 primeros bytes) => solo quien recibió la answer por la
	// señalización del master puede llegar a libjuice.
}

char LICENSE[] SEC("license") = "GPL";
